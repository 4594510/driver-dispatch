// The driver app: one page, talking to /api/driver. Inside the Android app it also uses the native bridge
// (window.DriverNative) for GPS in the background and notifications; in a plain browser it uses the browser's GPS
// while the page is open.
//
// Without signal: today's data is kept on the phone, actions wait in a queue (each with its own key, so the server
// does it once) and are sent when the signal comes back; GPS points wait the same way.
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const native = window.DriverNative || null;
const store = {
  get: (k, d = null) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* blocked */ } },
};

let token = store.get("driver.token");
let today = store.get("driver.today");
let tab = "next";
let queue = store.get("driver.queue", []);
let seenRequests = new Set(store.get("driver.seen", []));
let lastOk = store.get("driver.lastOk");
let reorder = null; // the Day tab's order while the driver is moving stops

const ERRORS = {
  not_pending: "This ride isn't waiting for an answer any more.", no_time: "The route can't fit this ride without making others late.",
  no_seats: "The seats don't work for this.", wrong_status: "Not possible now (the ride changed).", bad_time: "Choose a time within service hours.",
  dropoff_before_pickup: "A drop-off can't come before its pickup.", route_changed: "The route changed meanwhile. Look again.",
  bad_minutes: "Choose how many minutes.", not_found: "That ride is gone.",
};
const errText = (data) => (data?.errors || []).map((e) => ERRORS[e] || e).join(" ") || data?.error || "Something went wrong.";

function toast(msg, ms = 3000) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), ms);
}

const minuteText = (m) => {
  if (m == null) return "";
  m = Math.round(m);
  const h24 = Math.floor(m / 60);
  return `${((h24 + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
};
const people = (x) => !x.men && !x.women ? "📦 Package only, no riders" : [x.men ? `${x.men} ${x.men === 1 ? "man" : "men"}` : "", x.women ? `${x.women} ${x.women === 1 ? "woman" : "women"}` : ""].filter(Boolean).join(", ");
const ROWS = { front: "Front", row2: "Row 2", row3: "Row 3" };
const seatText = (seats) => Object.entries(seats || {}).map(([r, s]) => `${ROWS[r] || r}: ${people(s)}`).join(" · ");
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  // The server restarting (an update) answers 502-504 for a moment: the same as no signal, so the action waits.
  if (res.status >= 502 && res.status <= 504) throw Object.assign(new Error("server away"), { status: res.status });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/driver/login") { signOut(true); throw Object.assign(new Error("signed out"), { status: 401 }); }
  return { ok: res.ok, status: res.status, data };
}

// --- sign-in ---
function showLogin() {
  $("#app").hidden = true;
  $("#login").hidden = false;
}
function signOut(expired) {
  token = null;
  store.del("driver.token");
  store.del("driver.today");
  native?.stopTracking?.();
  showLogin();
  if (expired) $("#login-error").textContent = "Please sign in again.";
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try {
    const r = await api("/api/driver/login", { method: "POST", body });
    if (!r.ok) { $("#login-error").textContent = r.data.error || "Couldn't sign in."; return; }
    token = r.data.token;
    store.set("driver.token", token);
    $("#login-error").textContent = "";
    start();
  } catch {
    $("#login-error").textContent = "No signal. Try again when you have signal.";
  }
});

// --- the queue: actions and GPS made without signal ---
function enqueue(path, body) {
  queue.push({ path, body: { ...body, key: body.key || newKey() }, at: Date.now() });
  store.set("driver.queue", queue);
}
let flushing = false;
async function flush() {
  if (flushing || !queue.length || !token) return;
  flushing = true;
  try {
    while (queue.length) {
      const item = queue[0];
      let r;
      try { r = await api(item.path, { method: "POST", body: item.body }); } catch (e) { if (e.status === 401) return; break; }
      queue.shift();
      store.set("driver.queue", queue);
      if (!r.ok && !r.data.repeated) toast(`Sent after the signal came back, but: ${errText(r.data)}`, 6000);
    }
  } finally {
    flushing = false;
    showOffline();
  }
}

// Do an action now, or queue it when there's no signal (only those that make sense later).
async function act(path, body = {}, { queueable = true, ok } = {}) {
  const b = { ...body, key: newKey() };
  try {
    const r = await api(path, { method: "POST", body: b });
    if (!r.ok) { toast(errText(r.data), 5000); return null; }
    if (ok) toast(ok);
    await load();
    return r.data;
  } catch (e) {
    if (e.status === 401) return null;
    if (!queueable) { toast("No signal. Try again when you have signal.", 4000); return null; }
    enqueue(path, b);
    toast(`${ok || "Saved"}. It will be sent when the signal comes back.`, 4000);
    showOffline();
    return { queued: true };
  }
}

// --- loading ---
async function load() {
  try {
    const r = await api("/api/driver/today");
    if (!r.ok) return;
    today = r.data;
    // Presses still waiting to be sent (made without signal) stay shown as done, until the server has them.
    for (const q of queue) {
      const m = /\/bookings\/([^/]+)\/(pickup|done|no_show)$/.exec(q.path);
      if (m) markLocal(m[1], { pickup: "picked_up", done: "completed", no_show: "no_show" }[m[2]]);
    }
    lastOk = Date.now();
    store.set("driver.today", today);
    store.set("driver.lastOk", lastOk);
    alertNewRequests();
    track();
  } catch {
    /* no signal: show what we have */
  }
  showOffline();
  render();
}

function alertNewRequests() {
  const fresh = (today.requests || []).filter((r) => !seenRequests.has(r.id));
  if (fresh.length && today.driver.status === "online") {
    if (tab !== "next" && !reorder) tab = "next"; // a new ride: show it
    beep();
    navigator.vibrate?.([300, 150, 300]);
  }
  for (const r of fresh) seenRequests.add(r.id);
  store.set("driver.seen", [...seenRequests].slice(-200));
}
function beep() {
  try {
    const a = new (window.AudioContext || window.webkitAudioContext)();
    const o = a.createOscillator();
    o.frequency.value = 880;
    o.connect(a.destination);
    o.start();
    o.stop(a.currentTime + 0.35);
  } catch { /* no sound */ }
}

function showOffline() {
  const el = $("#offline");
  const parts = [];
  if (lastOk && Date.now() - lastOk > 60000) parts.push(`No signal since ${new Date(lastOk).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
  if (queue.length) parts.push(`${queue.length} waiting to send.`);
  el.textContent = parts.join(" ");
  el.hidden = !parts.length;
}

// --- GPS ---
let watch = null;
let tracking = null; // what the Android app was last told
let points = store.get("driver.points", []);
function track() {
  const status = today?.driver?.status;
  if (native) {
    // The app's own service rings for new requests, also with the screen off, and sends GPS only while online
    // (on a break it keeps checking, so it knows when the break is over, but shares no location).
    const on = status && status !== "offline";
    const want = on ? `on:${token}` : "off";
    if (want === tracking) return;
    tracking = want;
    if (on) native.startTracking?.(location.origin, token);
    else native.stopTracking?.();
    return;
  }
  // Without the Android app: GPS only while online (Start work), never on a break or after Stop work.
  const on = status === "online";
  if (on && watch == null && navigator.geolocation) {
    watch = navigator.geolocation.watchPosition((p) => {
      points.push({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, speed: p.coords.speed, at: new Date(p.timestamp).toISOString() });
      if (points.length > 5000) points = points.slice(-5000);
      store.set("driver.points", points);
    }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
  } else if (!on && watch != null) {
    navigator.geolocation.clearWatch(watch);
    watch = null;
  }
}
async function sendPoints() {
  if (!points.length || !token) return;
  const batch = points.slice(0, 500);
  try {
    const r = await api("/api/driver/location", { method: "POST", body: { points: batch } });
    if (r.ok || r.status === 400) {
      points = points.slice(batch.length);
      store.set("driver.points", points);
    }
  } catch { /* later */ }
}

// --- screens ---
function render() {
  if (!today) { $("#main").innerHTML = '<p class="quiet">Loading…</p>'; return; }
  const d = today.driver;
  $("#me").textContent = d.name;
  const st = $("#status");
  st.className = `pill ${d.status}`;
  st.textContent = d.status === "paused" && d.paused_until ? `Paused until ${new Date(d.paused_until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : { online: "Online", paused: "Paused", offline: "Offline" }[d.status];
  // One button: start or stop work (pause is under More).
  $("#work").innerHTML = d.status === "online"
    ? '<button class="ghost big" data-status="offline">Stop work</button>'
    : `<button class="good big" data-status="online">${d.status === "paused" ? "Back to work" : "Start work"}</button>`;
  const n = (today.requests || []).length;
  $("#req-count").textContent = n;
  $("#req-count").hidden = !n;
  const main = $("#main");
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === (tab === "hours" ? "more" : tab));
  if (tab === "next") main.innerHTML = nextView();
  else if (tab === "day") main.innerHTML = dayView();
  else if (tab === "hours") main.innerHTML = `<button class="ghost" data-tab-go="more">← Back</button>${hoursView()}`;
  else main.innerHTML = moreView();
}

function navLink(s) {
  const q = s.lat != null ? `${s.lat},${s.lng}` : encodeURIComponent(s.address || "");
  return `google.navigation:q=${q}`;
}
function mapsWeb(s) {
  const q = s.lat != null ? `${s.lat},${s.lng}` : encodeURIComponent(s.address || "");
  return `https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=driving`;
}

// The admin's priority level for a rider (High or Top); nothing for normal.
const prioBadge = (x) => (x?.priority > 0 ? ` <span class="prio p${x.priority}">${esc(x.priority_label || "High")} priority</span>` : "");

// A stop: what to do, when, who and where. The next stop is big, with one big button for what comes next.
function stopCard(s, big) {
  const pickup = s.kind === "pickup";
  const late = pickup && s.window && s.arrive > s.window[1];
  return `<div class="card ${big ? "next" : ""}">
    <div class="kind ${s.kind} ${big ? "huge" : ""}">${pickup ? "Pick up" : "Drop off"} · ${minuteText(s.arrive)}${late ? ' <span class="late">late</span>' : ""}</div>
    <h2>${esc(s.rider_name || "Ride")}${prioBadge(s)}</h2>
    <div class="addr">${esc(s.address)}</div>
    <div class="quiet">${people(s)}${s.together ? " · may sit together" : ""}</div>
    ${big && s.seats ? `<div class="quiet">Seats: ${esc(seatText(s.seats))}</div>` : ""}
    ${s.notes ? `<div class="notes">${esc(s.notes)}</div>` : ""}
    ${big ? `
      ${pickup ? `<button class="good huge-btn" data-act="pickup" data-id="${s.booking_id}">Picked up</button>`
        : `<button class="good huge-btn" data-act="done" data-id="${s.booking_id}">Dropped off</button>`}
      <div class="actions">
        <a href="${native ? navLink(s) : mapsWeb(s)}"><button class="ghost big" style="margin:0">Navigate</button></a>
        ${s.phone ? `<a href="tel:${esc(s.phone)}"><button class="ghost big" style="margin:0">Call</button></a>` : ""}
      </div>
      ${pickup ? `<button class="link" data-act="no_show" data-id="${s.booking_id}">Nobody came (no-show)</button>` : ""}` : ""}
  </div>`;
}

// A new ride request: who, from where to where, when; "Take it" or "Can't".
function requestCard(r) {
  const proposed = r.status === "proposed";
  return `<div class="card request">
    <div class="kind huge">${proposed ? "Waiting for the caller" : "New ride"}${r.return_of ? " · ride back" : ""}</div>
    <h2>${esc(r.rider_name || "Ride")}${prioBadge(r)}</h2>
    <div class="addr">${esc(r.from)} → ${esc(r.to)}</div>
    <div class="addr"><b>${proposed ? `You offered ${minuteText(r.proposed_minute)}` : minuteText(r.window[0])}</b> · ${people(r)}</div>
    ${proposed ? '<p class="quiet">The caller is asked to agree. Nothing to do now.</p>' : `
    <div class="actions">
      <button class="bad big" data-act="reject" data-id="${r.id}">Can't</button>
      <button class="good big" data-take="${r.id}">Take it</button>
    </div>
    <button class="link" data-propose="${r.id}">Offer another time</button>`}
  </div>`;
}

// The main screen: new requests first, then the next stop, then the two after it.
function nextView() {
  const reqs = (today.requests || []).map(requestCard).join("");
  const s = today.next;
  if (!s) {
    if (reqs) return reqs;
    return `<div class="card"><h2>No rides right now</h2><p class="quiet">${today.driver.status === "online" ? "A new ride shows here and the phone rings." : "Press Start work to get rides."}</p></div>`;
  }
  const after = today.route.stops.filter((x) => x.index > s.index && ["accepted", "picked_up"].includes(x.status)).slice(0, 2);
  return `${reqs}${stopCard(s, true)}${after.length ? `<h3 class="quiet">After that</h3>${after.map((x) => stopCard(x, false)).join("")}` : ""}`;
}

function dayView() {
  const stops = reorder || today.route.stops;
  if (!stops.length) return '<div class="card"><p class="quiet">No rides on the route today.</p></div>';
  const editing = !!reorder;
  return `<div class="card">
    <div class="quiet">${today.route.driveMinutes ?? 0} minutes of driving${today.route.estimated ? " (some guessed)" : ""}${today.route.manual ? " · your own order" : ""}</div>
    ${stops.map((s, i) => {
      const done = !["accepted", "picked_up"].includes(s.status) || (s.kind === "pickup" && s.status === "picked_up");
      return `<div class="stop ${done ? "done" : ""}">
        <div class="time">${editing ? "" : minuteText(s.arrive)}</div>
        <div class="body"><div class="kind ${s.kind}">${s.kind === "pickup" ? "Pick up" : "Drop off"}</div>
          <b>${esc(s.rider_name)}</b>${prioBadge(s)} · ${people(s)}<div class="quiet">${esc(s.address)}</div></div>
        ${editing ? `<div class="move"><button class="ghost" data-up="${i}" ${i === 0 ? "disabled" : ""}>▲</button><button class="ghost" data-down="${i}" ${i === stops.length - 1 ? "disabled" : ""}>▼</button></div>` : ""}
      </div>`;
    }).join("")}
  </div>
  ${editing
    ? `<div class="actions"><button class="ghost" data-reorder-cancel>Cancel</button><button class="good" data-reorder-save>Save this order</button></div>`
    : `<div class="actions"><button class="ghost" data-reorder>Change the order</button>${today.route.manual ? '<button class="ghost" data-auto>Back to the best order</button>' : ""}</div>`}`;
}

function moreView() {
  const d = today.driver;
  return `<div class="card">
    ${d.status === "online" ? '<button class="ghost big" data-status="paused">Take a break…</button>' : ""}
    <button class="ghost big" data-late>Running late…</button>
    <button class="ghost big" data-tab-go="hours">My hours (days off)</button>
    <button class="ghost big" data-feedback>Send a message to the office…</button>
    <button class="ghost big" data-refresh>Load again</button></div>
    <div class="card"><h2>${esc(d.name)}</h2><p class="quiet">${esc(d.phone)}</p>
    <button class="bad big" data-signout>Sign out</button></div>
    <p class="quiet">Updated ${lastOk ? new Date(lastOk).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "never"}.</p>`;
}

// --- hours: the driver changes the schedule for a day or a few days; callers hear it on the phone ---
let sched = null;
let schKind = "closed";
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Shabbos"];
const dayText = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const hoursText = (h) => (h.closed ? "No rides" : `${minuteText(h.openMinute)} – ${minuteText(h.closeMinute)}`);
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const toMinute = (s) => { const [h, m] = String(s || "").split(":").map(Number); return h * 60 + m; };

async function loadSchedule() {
  try {
    const r = await api("/api/driver/schedule");
    if (r.ok) sched = r.data;
  } catch { /* no signal */ }
  if (tab === "hours") render();
}
function hoursView() {
  if (!sched) return '<div class="card"><p class="quiet">Loading… (the hours need signal)</p></div>';
  const first = sched.days[0].day;
  return `<div class="card"><h2>Next two weeks</h2>
      <p class="quiet">Usually ${minuteText(sched.usual.openMinute)} – ${minuteText(sched.usual.closeMinute)}. Callers hear the changes on the phone.</p>
      ${sched.days.map((d) => `<div class="stop"><div class="body">${esc(dayText(d.day))}${d.day === first ? " (today)" : ""}</div>
        <div class="${d.changed ? (d.closed ? "late" : "") : "quiet"}">${d.changed ? `<b>${esc(hoursText(d))}</b>` : esc(hoursText(d))}</div></div>`).join("")}
      <button class="big" data-sch-add>Change my hours…</button></div>
    ${sched.changes.length ? `<div class="card"><h2>Changes</h2>${sched.changes.map((c) => `<div class="stop"><div class="body">
      ${esc(c.from === c.to ? dayText(c.from) : `${dayText(c.from)} to ${dayText(c.to)}`)}${c.weekdays ? ` <span class="quiet">(${c.weekdays.map((d) => WD[d]).join(", ")})</span>` : ""}
      <div><b>${esc(hoursText(c))}</b></div>${c.note ? `<div class="quiet">${esc(c.note)}</div>` : ""}</div>
      <button class="bad" data-sch-remove="${esc(c.id)}">Remove</button></div>`).join("")}
      <p class="quiet">When changes overlap, the newest one counts.</p></div>` : ""}`;
}
function readSheet() {
  const f = $("#sch-form");
  return f ? Object.fromEntries(new FormData(f)) : {};
}
function scheduleSheet(v = {}) {
  const first = sched?.days[0].day || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const open = v.open || hhmm(sched?.usual.openMinute ?? 600);
  const close = v.close || hhmm(sched?.usual.closeMinute ?? 1080);
  sheet(`<h2>Change my hours</h2><form id="sch-form" onsubmit="return false">
    <label>First day <input type="date" name="from" min="${first}" value="${esc(v.from || first)}"></label>
    <label>Last day <span class="quiet">(leave empty for one day)</span> <input type="date" name="to" min="${first}" value="${esc(v.to || "")}"></label>
    <div class="actions"><button type="button" class="${schKind === "closed" ? "bad on" : "ghost"}" data-sch-kind="closed">No rides</button>
      <button type="button" class="${schKind === "hours" ? "on" : "ghost"}" data-sch-kind="hours">Other hours</button></div>
    ${schKind === "hours" ? `<label>From <input type="time" name="open" value="${esc(open)}"></label><label>Until <input type="time" name="close" value="${esc(close)}"></label>` : ""}
    <label>Note <span class="quiet">(optional, not said on the phone)</span> <input name="note" maxlength="200" value="${esc(v.note || "")}"></label>
    <div class="actions"><button type="button" class="ghost" data-close>Cancel</button><button type="button" class="good" data-sch-save>Save</button></div></form>`);
}
async function saveSchedule() {
  const v = readSheet();
  const body = { from: v.from, to: v.to || v.from, closed: schKind === "closed", note: v.note };
  if (schKind === "hours") Object.assign(body, { openMinute: toMinute(v.open), closeMinute: toMinute(v.close) });
  const r = await act("/api/driver/schedule", body, { queueable: false, ok: "Saved. Callers will hear it." });
  if (!r) return;
  closeSheet();
  if (r.affected?.length) {
    alert(`${r.affected.length} ride${r.affected.length > 1 ? "s are" : " is"} already booked outside these hours (not cancelled):\n\n` +
      r.affected.map((b) => `${dayText(b.day)} ${minuteText(b.pickup_minute)}  ${b.rider_name}  ${b.phone}`).join("\n"));
  }
  loadSchedule();
}

// --- sheets (questions over the page) ---
function sheet(html) {
  $("#sheet-body").innerHTML = html;
  $("#sheet").hidden = false;
}
const closeSheet = () => ($("#sheet").hidden = true);
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet" || e.target.dataset.close != null) closeSheet(); });

async function preview(id) {
  sheet('<p class="quiet">Working out the route…</p>');
  let r;
  try { r = await api(`/api/driver/requests/${id}/preview`); } catch { sheet('<p>No signal. Accepting needs signal.</p><button class="ghost big" data-close>Close</button>'); return; }
  const req = today.requests.find((x) => x.id === id);
  if (!r.ok) {
    sheet(`<h2>Can't fit</h2><p>${esc(errText(r.data))}</p><div class="actions"><button class="ghost" data-close>Close</button><button class="ghost" data-propose="${id}">Suggest a time</button><button class="bad wide" data-act="reject" data-id="${id}">Reject</button></div>`);
    return;
  }
  const p = r.data;
  const shiftRows = Object.entries(p.shifts || {}).map(([bid, k]) => Object.entries(k).map(([kind, [a, b]]) =>
    `<tr><td>${esc(p.names[bid] || "")}</td><td>${kind === "pickup" ? "pick up" : "drop off"}</td><td>${minuteText(a)}</td><td class="${b > a ? "up" : "down"}">${minuteText(b)}</td></tr>`).join("")).join("");
  const blocks = p.blocks || [];
  const blockNote = blocks.length ? `<div class="notes" style="border:2px solid var(--bad)"><b>Wait:</b> if you take this ride there's no room for
    ${blocks.map((x) => `<b>${esc(x.rider_name || "a rider")}</b> (${esc(x.label)} priority, ${minuteText(x.window[0])})`).join(", ")}, who is also waiting.
    Higher priority goes first. <button class="ghost" data-preview="${esc(blocks[0].id)}" style="margin-top:6px">See ${esc(blocks[0].rider_name || "that ride")} first</button></div>` : "";
  sheet(`<h2>${esc(req?.rider_name || "Ride")}${prioBadge(req)}: pick up about ${minuteText(p.eta)}</h2>
    ${blockNote}
    <p class="quiet">Driving: ${p.before.driveMinutes} → ${p.after.driveMinutes} minutes</p>
    ${shiftRows ? `<p>Times that move:</p><table class="diff"><tbody>${shiftRows}</tbody></table>` : '<p class="quiet">Nobody else\'s time moves.</p>'}
    <p class="quiet" style="margin-top:12px">The new route:</p>
    ${p.after.stops.map((s) => `<div class="stop"><div class="time">${minuteText(s.arrive)}</div><div class="body">${s.kind === "pickup" ? "Pick up" : "Drop off"} <b>${esc(p.names[s.booking_id] || "")}</b>${s.booking_id === id ? " (new)" : ""}</div></div>`).join("")}
    <div class="actions"><button class="bad" data-act="reject" data-id="${id}">Reject</button><button class="ghost" data-propose="${id}">Suggest a time</button>
    <button class="${blocks.length || p.seatConflict ? "bad" : "good"} big wide" data-act="accept" data-id="${id}" ${p.seatConflict ? 'data-override="1"' : ""}>${blocks.length || p.seatConflict ? "Accept anyway" : "Accept"}</button><button class="ghost wide" data-close>Close</button></div>`);
}

// "Take it": check the route first. When it fits and moves nobody, it's accepted right away; otherwise a short
// question says what changes. The full route is behind "Details".
async function take(id) {
  sheet('<p class="quiet">Checking the route…</p>');
  let r;
  try { r = await api(`/api/driver/requests/${id}/preview`); } catch { sheet('<p>No signal. Taking a ride needs signal.</p><button class="ghost big" data-close>Close</button>'); return; }
  const req = (today.requests || []).find((x) => x.id === id);
  if (!r.ok) {
    sheet(`<h2>This ride doesn't fit</h2><p>${esc(errText(r.data))}</p>
      <button class="good big" data-propose="${id}">Offer another time</button>
      <button class="bad big" data-act="reject" data-id="${id}">Can't take it</button>
      <button class="ghost big" data-close>Close</button>`);
    return;
  }
  const p = r.data;
  const moved = Object.keys(p.shifts || {}).length;
  const blocks = p.blocks || [];
  const seat = !!p.seatConflict;
  if (!moved && !blocks.length && !seat) {
    closeSheet();
    await act(`/api/driver/bookings/${id}/accept`, {}, { queueable: false, ok: `Taken. Pick up about ${minuteText(p.eta)}` });
    return;
  }
  sheet(`<h2>${esc(req?.rider_name || "Ride")}: pick up about ${minuteText(p.eta)}</h2>
    ${moved ? `<p>${moved} other ride${moved > 1 ? "s" : ""} will be a little later. They get a message if needed.</p>` : ""}
    ${blocks.length ? `<div class="notes" style="border:2px solid var(--bad)"><b>Wait:</b> ${blocks.map((x) => `<b>${esc(x.rider_name || "a rider")}</b>`).join(", ")}
      is also waiting and goes first (${esc(blocks[0].label)} priority). If you take this one, there's no room for them.</div>` : ""}
    ${seat ? `<div class="notes" style="border:2px solid var(--warn)"><b>Seats:</b> with this ride, men and women can't each get their own rows
      (${esc(people(req || p.seatsOnBoard || {}))} on this ride). You can still take it and seat them yourself.</div>` : ""}
    <button class="${blocks.length || seat ? "bad" : "good"} big" data-act="accept" data-id="${id}" ${seat ? 'data-override="1"' : ""}>${blocks.length || seat ? "Take it anyway" : "Take it"}</button>
    <button class="bad big" data-act="reject" data-id="${id}">Can't</button>
    <button class="link" data-preview="${id}">Details</button>`);
}

function proposeSheet(id) {
  const r = today.requests.find((x) => x.id === id);
  const base = r ? r.window[0] : 600;
  const times = [];
  const h = today.hours || { openMinute: 600, closeMinute: 1080 };
  for (let m = base - 60; m <= base + 90; m += 15) if (m !== base && m >= h.openMinute && m <= h.closeMinute) times.push(m);
  sheet(`<h2>Suggest a time for ${esc(r?.rider_name || "this ride")}</h2><p class="quiet">The caller is asked to agree.</p>
    <div class="chips">${times.map((m) => `<button class="ghost" data-propose-at="${m}" data-id="${id}">${minuteText(m)}</button>`).join("")}</div>
    <button class="ghost big" data-close>Cancel</button>`);
}

function lateSheet() {
  sheet(`<h2>Running late by…</h2><p class="quiet">Riders who'd be past their window get a message with the new time.</p>
    <div class="chips">${[5, 10, 15, 20, 30, 45].map((m) => `<button class="ghost" data-late-by="${m}">${m} min</button>`).join("")}</div>
    <button class="ghost big" data-close>Cancel</button>`);
}

function pauseSheet() {
  sheet(`<h2>Take a break for…</h2><p class="quiet">Callers hear the driver isn't available. Work starts again by itself.</p>
    <div class="chips">${[15, 30, 60, 120].map((m) => `<button class="ghost" data-pause="${m}">${m < 60 ? `${m} min` : `${m / 60} hour${m > 60 ? "s" : ""}`}</button>`).join("")}</div>
    <button class="ghost big" data-close>Cancel</button>`);
}

// Comments, complaints, suggestions and requests, with the answers to earlier ones.
const FB_STATUS = { new: "Sent", working: "Being worked on", needs_you: "Waiting on the office", done: "Done", declined: "Not done" };
async function feedbackSheet() {
  let past = [];
  try { const r = await api("/api/driver/feedback"); if (r.ok) past = r.data; } catch { /* no signal: the form still works */ }
  sheet(`<h2>Comment, complaint or request</h2>
    <label>What kind <select id="fb-kind"><option value="request">Request</option><option value="suggestion">Suggestion</option><option value="complaint">Complaint</option><option value="comment">Comment</option></select></label>
    <label>Write it here <textarea id="fb-text" rows="5"></textarea></label>
    <button class="good big" data-feedback-send>Send</button>
    <button class="ghost big" data-close>Close</button>
    ${past.length ? `<h3>Sent before</h3>${past.map((f) => `<div class="card"><p>${esc(f.text)}</p><p class="quiet">${esc(new Date(f.created_at).toLocaleDateString())} · ${esc(FB_STATUS[f.status] || f.status)}</p>${f.reply ? `<p class="quiet">Answer: ${esc(f.reply)}</p>` : ""}</div>`).join("")}` : ""}`);
}

// Local change right away, so the driver can go on without signal.
function markLocal(id, status) {
  if (!today) return;
  for (const s of today.route.stops) if (s.booking_id === id) s.status = status;
  today.next = today.route.stops.find((s) => (s.kind === "pickup" && s.status === "accepted") || (s.kind === "dropoff" && s.status === "picked_up")) || null;
  store.set("driver.today", today);
}

// --- clicks ---
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, [data-tab-go]");
  if (!t) return;
  const ds = t.dataset;
  if (ds.tab || ds.tabGo) { closeSheet(); tab = ds.tab || ds.tabGo; reorder = null; render(); if (tab === "hours") loadSchedule(); return; }
  if (ds.schAdd != null) return scheduleSheet();
  if (ds.schKind) { schKind = ds.schKind; scheduleSheet(readSheet()); return; }
  if (ds.schSave != null) return saveSchedule();
  if (ds.schRemove) {
    if (!confirm("Remove this change? Those days go back to the usual hours.")) return;
    const r = await act(`/api/driver/schedule/${ds.schRemove}/remove`, {}, { queueable: false, ok: "Removed" });
    if (r) loadSchedule();
    return;
  }
  if (ds.status) {
    if (ds.status === "paused") return pauseSheet();
    if (ds.status === "offline" && !confirm("Stop work? New rides will wait until you start again.")) return;
    await act("/api/driver/status", { status: ds.status }, { ok: ds.status === "online" ? "Started. Rides will come in" : "Stopped" });
    return;
  }
  if (ds.pause) { closeSheet(); await act("/api/driver/status", { status: "paused", minutes: Number(ds.pause) }, { ok: "Paused" }); return; }
  if (ds.act) {
    const id = ds.id;
    const names = { pickup: "Picked up", done: "Dropped off", no_show: "No-show", accept: "Taken", reject: "The caller is told" };
    if (ds.act === "no_show" && !confirm("Nobody came? The seats are freed.")) return;
    if (ds.act === "reject" && !confirm("Can't take this ride? The caller gets a message.")) return;
    closeSheet();
    const queueable = ["pickup", "done", "no_show"].includes(ds.act);
    if (queueable) { markLocal(id, { pickup: "picked_up", done: "completed", no_show: "no_show" }[ds.act]); render(); }
    await act(`/api/driver/bookings/${id}/${ds.act}`, ds.override ? { override: true } : {}, { queueable, ok: names[ds.act] });
    return;
  }
  if (ds.take) return take(ds.take);
  if (ds.preview) return preview(ds.preview);
  if (ds.propose) return proposeSheet(ds.propose);
  if (ds.proposeAt) { closeSheet(); await act(`/api/driver/bookings/${ds.id}/propose`, { minute: Number(ds.proposeAt) }, { queueable: false, ok: "Sent to the caller" }); return; }
  if (ds.late != null) return lateSheet();
  if (ds.feedback != null) return feedbackSheet();
  if (ds.feedbackSend != null) {
    const text = $("#fb-text").value.trim();
    if (!text) { toast("Write something first."); return; }
    closeSheet();
    await act("/api/driver/feedback", { kind: $("#fb-kind").value, text }, { ok: "Sent. Thank you" });
    return;
  }
  if (ds.lateBy) { closeSheet(); await act("/api/driver/late", { minutes: Number(ds.lateBy) }, { ok: "Riders told" }); return; }
  if (ds.reorder != null) { reorder = today.route.stops.filter((s) => ["accepted", "picked_up"].includes(s.status) && !(s.kind === "pickup" && s.status === "picked_up")).map((s) => ({ ...s })); render(); return; }
  if (ds.reorderCancel != null) { reorder = null; render(); return; }
  if (ds.up || ds.down) {
    const i = Number(ds.up ?? ds.down);
    const j = ds.up ? i - 1 : i + 1;
    [reorder[i], reorder[j]] = [reorder[j], reorder[i]];
    render();
    return;
  }
  if (ds.reorderSave != null) {
    const r = await act("/api/driver/route/order", { stops: reorder.map((s) => ({ booking_id: s.booking_id, kind: s.kind })) }, { queueable: false, ok: "Order saved" });
    if (r) reorder = null;
    const late = r?.route ? Object.keys(r.route.late || {}).length : 0;
    if (late) toast(`Saved. With this order ${late} pickup${late > 1 ? "s are" : " is"} late.`, 6000);
    render();
    return;
  }
  if (ds.auto != null) { await act("/api/driver/route/auto", {}, { queueable: false, ok: "Back to the best order" }); return; }
  if (ds.refresh != null) { await load(); toast("Loaded"); return; }
  if (ds.signout != null) {
    if (!confirm("Sign out?")) return;
    try { await api("/api/driver/logout", { method: "POST", body: {} }); } catch { /* fine */ }
    signOut(false);
  }
});

// --- start ---
function start() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  render();
  load();
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
window.addEventListener("online", () => { flush(); load(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) { flush(); load(); } });
setInterval(() => { flush(); load(); }, 15000);
setInterval(sendPoints, 10000);
if (token) start();
else showLogin();
