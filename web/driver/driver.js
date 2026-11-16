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
let reorder = null; // the route's order while the driver is moving stops
let jumpToRequests = false; // a new request came: show the requests from the top

const ERRORS = {
  not_pending: "This ride isn't waiting for an answer any more.", no_time: "The route can't fit this ride without making others late.",
  no_seats: "The seats don't work for this.", wrong_status: "Not possible now (the ride changed).", bad_time: "Choose a time within service hours.",
  dropoff_before_pickup: "A drop-off can't come before its pickup.", route_changed: "The route changed meanwhile. Look again.",
  bad_minutes: "Choose how many minutes.", not_found: "That ride is gone.", past_time: "That time already passed. Choose a later one.",
  not_registered: "Choose who the ride is for.", no_riders: "Choose how many men and women (or a package).", no_pickup: "Choose where from.",
  no_dropoff: "Choose where to.", outside_hours: "That time is outside today's hours.", closed: "There are no rides today.",
  in_past: "That time already passed.", driver_break: "That time is inside one of your breaks.", too_far: "That trip is longer than 30 minutes.",
  full: "The van is full then.", no_seating: "The seats don't work for this.",
};
const errText = (data) => (data?.errors || []).map((e) => ERRORS[e] || e).join(" ") || data?.error || "Something went wrong.";

function toast(msg, ms = 3000) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), ms);
}

// Questions and notices on the page itself. The Android app shows no confirm() or alert() boxes: confirm() answers
// "no" there by itself, so "Can't", "Stop work" and the other asked buttons did nothing (driver feedback, 2026-11-16).
let askDone = null;
function ask(text, yes = "Yes", danger = false) {
  return new Promise((resolve) => {
    if (askDone) askDone(false);
    sheet(`<h2>${esc(text)}</h2><div class="actions"><button class="ghost big" data-ask="no">No</button><button class="${danger ? "bad" : "good"} big" data-ask="yes">${esc(yes)}</button></div>`);
    askDone = resolve;
  });
}
function info(text) {
  sheet(`<p>${esc(text).replace(/\n/g, "<br>")}</p><button class="ghost big" data-close>OK</button>`);
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
    jumpToRequests = true;
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
    // The app's own service rings for new requests, also with the screen off, and sends GPS only while the server
    // says so (online, sharing on, inside the service hours); on a break it keeps checking but shares no location.
    const on = status && status !== "offline";
    const want = on ? `on:${token}` : "off";
    if (want === tracking) return;
    tracking = want;
    if (on) native.startTracking?.(location.origin, token);
    else native.stopTracking?.();
    return;
  }
  // Without the Android app: GPS only while the server says so (at work, sharing on, inside the service hours).
  const on = status === "online" && today?.driver?.tracking !== false;
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
  const scrolls = [...main.querySelectorAll(".pane")].map((p) => p.scrollTop);
  main.classList.toggle("split", tab === "next");
  if (tab === "next") {
    main.innerHTML = ridesView();
    if (!jumpToRequests) main.querySelectorAll(".pane").forEach((p, i) => (p.scrollTop = scrolls[i] || 0));
    jumpToRequests = false;
  } else if (tab === "hours") main.innerHTML = `<button class="ghost" data-tab-go="more">← Back</button>${hoursView()}`;
  else main.innerHTML = updateView() + moreView();
}

// A newer Android app is out: one card with one button (the app downloads it and Android asks "Update?").
function newerApp() {
  let mine = 0;
  try { mine = Number(native?.appVersion?.()) || 0; } catch { /* old app without it */ }
  return native?.update && today.app?.version > mine ? today.app : null;
}
function updateView() {
  return newerApp() ? `<div class="card"><h2>New app version ready</h2><button class="good big" data-update>Update</button></div>` : "";
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
  return `<div class="card ${big ? "next" : ""}">
    <div class="kind ${s.kind} ${big ? "huge" : ""}">${pickup ? "Pick up" : "Drop off"} · ${minuteText(s.arrive)}</div>
    <h2>${esc(s.rider_name || "Ride")}${prioBadge(s)}</h2>
    ${pickup ? timesLine(s, s.arrive) : ""}
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

// Asked, accepted (the pickup time the caller was told), the ETA, and on time or late (driver feedback, 2026-11-16).
// Late is counted from the accepted time (or the end of the asked window when nothing was told yet).
function timesLine(x, eta) {
  const parts = [];
  if (x.asked != null) parts.push(`Asked <b>${minuteText(x.asked)}</b>`);
  if (x.told != null) parts.push(`Accepted <b>${minuteText(x.told)}</b>`);
  if (eta != null) parts.push(`ETA <b>${minuteText(eta)}</b>`);
  const promised = x.told ?? x.window?.[1];
  let state = "";
  if (eta != null && promised != null) {
    const late = Math.round(eta - promised);
    state = late > 0 ? ` <span class="tag no">${late} min late</span>` : ' <span class="tag taken">On time</span>';
  }
  return parts.length ? `<div class="times">${parts.join(" · ")}${state}</div>` : "";
}

// A new ride request: who, from where to where, when; "Take it" or "Can't".
function requestCard(r) {
  const proposed = r.status === "proposed";
  return `<div class="card request ${proposed ? "offered" : "waiting"}">
    <div>${statusTag(r.status)}${r.return_of ? ' <span class="quiet">ride back</span>' : ""}</div>
    <h2>${esc(r.rider_name || "Ride")}${prioBadge(r)}</h2>
    <div class="addr">${esc(r.from)} → ${esc(r.to)}</div>
    <div class="addr"><b>${proposed ? `You offered ${minuteText(r.proposed_minute)}` : minuteText(r.window[0])}</b> · ${people(r)}</div>
    ${proposed ? `<div class="times">They asked for <b>${minuteText(r.asked ?? r.window[0])}</b></div>` : r.asked != null && r.asked !== r.window[0] ? `<div class="times">First asked for <b>${minuteText(r.asked)}</b></div>` : ""}
    ${proposed ? '<p class="quiet">The caller is asked to agree. Nothing to do now.</p>' : `
    <div class="actions">
      <button class="bad big" data-act="reject" data-id="${r.id}">Can't</button>
      <button class="good big" data-take="${r.id}">Take it</button>
    </div>
    <button class="link" data-propose="${r.id}">Offer another time</button>`}
  </div>`;
}

// The one main screen (2026-11-16, the driver found the tabs confusing): the route on one half, every ride of the day
// with where it stands on the other. Side by side on a wide screen, one above the other on a phone.
function ridesView() {
  const route = routePane();
  const rides = ridesPane();
  return `${updateView()}<section class="pane ${route.empty ? "small" : ""}"><h3 class="pane-title">Route${route.sub}</h3>${route.html}</section>
    <section class="pane ${rides.empty ? "small" : ""}"><h3 class="pane-title">Requests${rides.sub}</h3>${rides.html}</section>`;
}

// The route: the next stop big, with its button, then the stops after it in order.
function routePane() {
  if (reorder) return { sub: "", html: orderEditor() };
  const s = today.next;
  const left = today.route.stops.filter((x) => ["accepted", "picked_up"].includes(x.status) && !(x.kind === "pickup" && x.status === "picked_up"));
  const sub = left.length ? ` <span class="quiet">· ${left.length} stop${left.length > 1 ? "s" : ""} · ${today.route.driveMinutes ?? 0} min driving${today.route.estimated ? " (some guessed)" : ""}</span>` : "";
  if (!s) {
    return { empty: true, sub, html: `<div class="card"><h2>No stops right now</h2><p class="quiet">${today.driver.status === "online" ? "Rides you take show here, in order." : "Press Start work to get rides."}</p></div>` };
  }
  const after = left.filter((x) => x.index > s.index);
  return {
    sub,
    html: `${stopCard(s, true)}${after.length ? `<div class="card list">${after.map(stopRow).join("")}</div>` : ""}
      <div class="actions"><button class="ghost" data-reorder>Change the order</button>${today.route.manual ? '<button class="ghost" data-auto>Back to the best order</button>' : ""}</div>`,
  };
}
function stopRow(s) {
  return `<div class="stop"><div class="time">${minuteText(s.arrive)}</div>
    <div class="body"><div class="kind ${s.kind}">${s.kind === "pickup" ? "Pick up" : "Drop off"}</div>
      <b>${esc(s.rider_name || "Ride")}</b>${prioBadge(s)} · ${people(s)}<div class="quiet">${esc(s.address)}</div>
      ${s.kind === "pickup" ? timesLine(s, s.arrive) : ""}</div></div>`;
}
function orderEditor() {
  const stops = reorder;
  return `<div class="card list">${stops.map((s, i) => `<div class="stop">
      <div class="body"><div class="kind ${s.kind}">${s.kind === "pickup" ? "Pick up" : "Drop off"}</div>
        <b>${esc(s.rider_name)}</b> · ${people(s)}<div class="quiet">${esc(s.address)}</div></div>
      <div class="move"><button class="ghost" data-up="${i}" ${i === 0 ? "disabled" : ""}>▲</button><button class="ghost" data-down="${i}" ${i === stops.length - 1 ? "disabled" : ""}>▼</button></div>
    </div>`).join("")}</div>
    <div class="actions"><button class="ghost" data-reorder-cancel>Cancel</button><button class="good" data-reorder-save>Save this order</button></div>`;
}

// Where a ride stands, in plain words, with a colour.
const STATUS = {
  pending: ["New", "new"], proposed: ["Waiting for the caller", "wait"], accepted: ["Taken", "taken"], picked_up: ["On board", "taken"],
  completed: ["Done", "done"], rejected: ["Declined", "no"], cancelled: ["Cancelled", "no"], no_show: ["No-show", "no"],
};
const statusTag = (st) => { const [t, c] = STATUS[st] || [st, "done"]; return `<span class="tag ${c}">${esc(t)}</span>`; };

// The requests: new ones first with "Take it" / "Can't", then every other ride of the day with where it stands.
function ridesPane() {
  const reqs = today.requests || [];
  const others = today.rides || [];
  const waiting = reqs.filter((r) => r.status === "pending").length;
  const sub = `${waiting ? ` <span class="count">${waiting} new</span>` : ""}<button class="ghost small" data-add-ride>+ Add a ride</button>`;
  if (!reqs.length && !others.length) return { empty: true, sub, html: '<div class="card"><p class="quiet">No requests yet today. A new one shows here and the phone rings.</p></div>' };
  return {
    sub,
    html: `${reqs.map(requestCard).join("")}${others.length ? `<div class="card list">${others.map(rideRow).join("")}</div>` : ""}`,
  };
}
function rideRow(r) {
  const finished = ["completed", "rejected", "cancelled", "no_show"].includes(r.status);
  return `<div class="stop ${finished ? "done" : ""}"><div class="time">${minuteText(r.window[0])}</div>
    <div class="body">${statusTag(r.status)}${r.return_of ? ' <span class="quiet">ride back</span>' : ""}
      <div><b>${esc(r.rider_name || "Ride")}</b> · ${people(r)}</div><div class="quiet">${esc(r.from)} → ${esc(r.to)}</div>
      ${finished ? "" : timesLine(r, r.status === "accepted" ? r.eta : null)}</div></div>`;
}

function moreView() {
  const d = today.driver;
  return `<div class="card">
    ${d.status === "online" ? '<button class="ghost big" data-status="paused">Take a break…</button>' : ""}
    <button class="ghost big" data-late>Running late…</button>
    <button class="ghost big" data-sharing="${d.share_location ? "off" : "on"}">${d.share_location ? "Stop sharing my location" : "Share my location again"}</button>
    <p class="quiet">${d.share_location ? "Your location is shared only while you are at work, inside the service hours." : "Your location is not shared. The office can't see where you are."}</p>
    <button class="ghost big" data-tab-go="hours">My hours, days off and breaks</button>
    <button class="ghost big" data-add-ride>Add a ride…</button>
    <button class="ghost big" data-add-place>Add a place (address and code)…</button>
    <button class="ghost big" data-everyone>Send a message to everyone…</button>
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
// The hours as a calendar, one week at a time (driver feedback, 2026-11-16): tap a day to change it or add a break.
let week = 0;
function hoursView() {
  if (!sched) return '<div class="card"><p class="quiet">Loading… (the hours need signal)</p></div>';
  const first = sched.days[0].day;
  const days = sched.days.slice(week * 7, week * 7 + 7);
  const breaksOn = (day) => (sched.breaks || []).filter((b) => b.day === day);
  return `<div class="card"><div class="actions"><button class="${week === 0 ? "on" : "ghost"}" data-week="0">This week</button><button class="${week === 1 ? "on" : "ghost"}" data-week="1">Next week</button></div>
      <p class="quiet">Usually ${minuteText(sched.usual.openMinute)} – ${minuteText(sched.usual.closeMinute)}. Tap a day to change it. Callers hear the changes on the phone.</p>
      <div class="week">${days.map((d) => {
        const brk = breaksOn(d.day);
        return `<button class="day ${d.closed ? "closed" : d.changed ? "changed" : ""}" data-day="${esc(d.day)}">
          <span class="dname">${esc(dayText(d.day))}${d.day === first ? " · today" : ""}</span>
          <span class="dhours">${esc(hoursText(d))}</span>
          ${brk.length ? `<span class="dbreak">${brk.map((b) => `Break ${esc(minuteText(b.startMinute))} – ${esc(minuteText(b.endMinute))}`).join("<br>")}</span>` : ""}</button>`;
      }).join("")}</div>
      <button class="big" data-sch-add>Change several days…</button></div>
    ${sched.changes.length ? `<div class="card"><h2>Changes</h2>${sched.changes.map((c) => `<div class="stop"><div class="body">
      ${esc(c.from === c.to ? dayText(c.from) : `${dayText(c.from)} to ${dayText(c.to)}`)}${c.weekdays ? ` <span class="quiet">(${c.weekdays.map((d) => WD[d]).join(", ")})</span>` : ""}
      <div><b>${esc(hoursText(c))}</b></div>${c.note ? `<div class="quiet">${esc(c.note)}</div>` : ""}</div>
      <button class="bad" data-sch-remove="${esc(c.id)}">Remove</button></div>`).join("")}
      <p class="quiet">When changes overlap, the newest one counts.</p></div>` : ""}
    <div class="card"><h2>Breaks</h2>
      <p class="quiet">Times you are not available. No pickups start inside a break; callers are offered the time after it.</p>
      ${(sched.breaks || []).map((b) => `<div class="stop"><div class="body">${esc(dayText(b.day))}${b.day === first ? " (today)" : ""}
        <div><b>${esc(minuteText(b.startMinute))} – ${esc(minuteText(b.endMinute))}</b></div>${b.note ? `<div class="quiet">${esc(b.note)}</div>` : ""}</div>
        <button class="bad" data-brk-remove="${esc(b.id)}">Remove</button></div>`).join("") || '<p class="quiet">No breaks planned.</p>'}
      <button class="big" data-brk-add>Add a break…</button></div>`;
}
// One day of the calendar: its hours and breaks, and what can be changed.
function daySheet(day) {
  const d = sched.days.find((x) => x.day === day);
  if (!d) return;
  const brk = (sched.breaks || []).filter((b) => b.day === day);
  sheet(`<h2>${esc(dayText(day))}</h2><p><b>${esc(hoursText(d))}</b>${d.changed ? ' <span class="quiet">(changed)</span>' : ""}</p>
    ${brk.map((b) => `<p>Break ${esc(minuteText(b.startMinute))} – ${esc(minuteText(b.endMinute))}</p>`).join("")}
    <button class="big" data-day-hours="${esc(day)}">Other hours this day…</button>
    <button class="bad big" data-day-closed="${esc(day)}">No rides this day…</button>
    <button class="ghost big" data-brk-add="${esc(day)}">Add a break this day…</button>
    <button class="ghost big" data-close>Close</button>`);
}
function breakSheet(day) {
  const first = sched?.days[0].day || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  sheet(`<h2>Add a break</h2><form id="brk-form" onsubmit="return false">
    <label>Day <input type="date" name="day" min="${first}" value="${esc(day || first)}"></label>
    <label>From <input type="time" name="start" value="13:00"></label><label>Until <input type="time" name="end" value="13:30"></label>
    <label>Note <span class="quiet">(optional)</span> <input name="note" maxlength="200"></label>
    <div class="actions"><button type="button" class="ghost" data-close>Cancel</button><button type="button" class="good" data-brk-save>Save</button></div></form>
    <p class="quiet">You can add more than one break on the same day.</p>`);
}
async function saveBreak() {
  const v = Object.fromEntries(new FormData($("#brk-form")));
  const r = await act("/api/driver/breaks", { day: v.day, startMinute: toMinute(v.start), endMinute: toMinute(v.end), note: v.note }, { queueable: false, ok: "Break saved" });
  if (!r) return;
  closeSheet();
  await loadSchedule();
  if (r.affected?.length) info(`${r.affected.length} ride${r.affected.length > 1 ? "s are" : " is"} already booked in this break (not cancelled).`);
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
  await loadSchedule();
  if (r.affected?.length) {
    info(`${r.affected.length} ride${r.affected.length > 1 ? "s are" : " is"} already booked outside these hours (not cancelled):\n\n` +
      r.affected.map((b) => `${dayText(b.day)} ${minuteText(b.pickup_minute)}  ${b.rider_name}  ${b.phone}`).join("\n"));
  }
}

// --- sheets (questions over the page) ---
function sheet(html) {
  $("#sheet-body").innerHTML = html;
  $("#sheet").hidden = false;
}
function closeSheet() {
  $("#sheet").hidden = true;
  const f = askDone; // a question closed without an answer is a "no"
  askDone = null;
  f?.(false);
}
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
  const late = p.asked != null;
  if (!moved && !blocks.length && !seat && !late) {
    closeSheet();
    await act(`/api/driver/bookings/${id}/accept`, {}, { queueable: false, ok: `Taken. Pick up about ${minuteText(p.eta)}` });
    return;
  }
  sheet(`<h2>${esc(req?.rider_name || "Ride")}: pick up about ${minuteText(p.eta)}</h2>
    ${late ? `<div class="notes" style="border:2px solid var(--warn)"><b>Later than asked:</b> they asked for ${minuteText(p.asked)}.
      By GPS you'll get there about ${minuteText(p.eta)}. If you take it, they are told ${minuteText(p.eta)}.</div>` : ""}
    ${moved ? `<p>${moved} other ride${moved > 1 ? "s" : ""} will be a little later. They get a message if needed.</p>` : ""}
    ${blocks.length ? `<div class="notes" style="border:2px solid var(--bad)"><b>Wait:</b> ${blocks.map((x) => `<b>${esc(x.rider_name || "a rider")}</b>`).join(", ")}
      is also waiting and goes first (${esc(blocks[0].label)} priority). If you take this one, there's no room for them.</div>` : ""}
    ${seat ? `<div class="notes" style="border:2px solid var(--warn)"><b>Seats:</b> with this ride, men and women can't each get their own rows
      (${esc(people(req || p.seatsOnBoard || {}))} on this ride). You can still take it and seat them yourself.</div>` : ""}
    <button class="${blocks.length || seat ? "bad" : "good"} big" data-act="accept" data-id="${id}" ${seat ? 'data-override="1"' : ""}>${blocks.length || seat ? "Take it anyway" : "Take it"}</button>
    ${late ? `<button class="ghost big" data-propose="${id}">Offer another time</button>` : ""}
    <button class="bad big" data-act="reject" data-id="${id}">Can't</button>
    <button class="link" data-preview="${id}">Details</button>`);
}

function proposeSheet(id) {
  const r = today.requests.find((x) => x.id === id);
  const base = r ? r.window[0] : 600;
  const times = [];
  const h = today.hours || { openMinute: 600, closeMinute: 1080 };
  // Only times still ahead: for a ride asked for "now" a while ago, the choices start from now, not from its old time.
  const nowM = today.minute + Math.max(0, Math.round((Date.now() - (lastOk || Date.now())) / 60000));
  const from = Math.max(base - 60, Math.ceil(nowM / 5) * 5);
  for (let m = from; times.length < 10 && m <= h.closeMinute; m += 15) if (m !== base && m >= h.openMinute) times.push(m);
  sheet(`<h2>Suggest a time for ${esc(r?.rider_name || "this ride")}</h2><p class="quiet">The caller is asked to agree.</p>
    <div class="chips">${times.map((m) => `<button class="ghost" data-propose-at="${m}" data-id="${id}">${minuteText(m)}</button>`).join("")}</div>
    <label>Or any time <input type="time" id="propose-time" step="60"></label>
    <button class="good big" data-propose-typed="${id}">Offer this time</button>
    <button class="ghost big" data-close>Cancel</button>`);
}

// The driver adds a ride himself (driver feedback, 2026-11-16): who (a phone on the list), how many, from, to, when.
// It is saved as a request, then taken the usual way (it shows what changes first when needed).
let bookOptions = null;
async function addRideSheet() {
  sheet('<p class="quiet">Loading…</p>');
  try { const r = await api("/api/driver/book-options"); if (r.ok) bookOptions = r.data; } catch { /* no signal */ }
  if (!bookOptions) { info("No signal. Adding a ride needs signal."); return; }
  const placeOpts = `<option value="">Type an address below</option>${bookOptions.places.map((p) => `<option value="${esc(p.id)}">${esc(p.code)} · ${esc(p.name)}</option>`).join("")}`;
  const count = (name) => `<select name="${name}">${[0, 1, 2, 3, 4, 5, 6, 7].map((n) => `<option>${n}</option>`).join("")}</select>`;
  sheet(`<h2>Add a ride</h2><form id="ride-form" onsubmit="return false">
    <label>For <select name="phone"><option value="">Choose…</option>${bookOptions.phones.map((p) => `<option value="${esc(p.number)}">${esc(p.label)}</option>`).join("")}</select></label>
    <label>Name or note <span class="quiet">(optional)</span> <input name="riderName" maxlength="80"></label>
    <div class="actions"><label>Men ${count("men")}</label><label>Women ${count("women")}</label></div>
    <label class="check"><input type="checkbox" name="package"> Just a package (no riders)</label>
    <label>From <select name="from">${placeOpts}</select></label><input name="fromAddress" placeholder="Or an address, e.g. 12 Main St, Monsey">
    <label>To <select name="to">${placeOpts}</select></label><input name="toAddress" placeholder="Or an address, e.g. 12 Main St, Monsey">
    <label>Pickup time <span class="quiet">(empty = now)</span> <input type="time" name="time" step="60"></label>
    <div class="actions"><button type="button" class="ghost" data-close>Cancel</button><button type="button" class="good" data-ride-save>Add and take it</button></div></form>`);
}
async function saveRide() {
  const f = new FormData($("#ride-form"));
  const end = (sel, typed) => (f.get(sel) ? { placeId: f.get(sel) } : { address: String(f.get(typed) || "").trim() });
  const body = {
    phone: f.get("phone"), riderName: f.get("riderName"), package: !!f.get("package"),
    men: Number(f.get("men")), women: Number(f.get("women")),
    pickup: end("from", "fromAddress"), dropoff: end("to", "toAddress"), pickupMinute: f.get("time") ? toMinute(f.get("time")) : null,
  };
  const r = await act("/api/driver/rides", body, { queueable: false });
  if (!r?.id) return;
  closeSheet();
  await take(r.id);
}

// The driver adds a saved place with its code (driver feedback, 2026-11-16). Everyone can use it on the phone.
function addPlaceSheet() {
  sheet(`<h2>Add a place</h2><form id="place-form" onsubmit="return false">
    <label>Name <input name="name" maxlength="80" placeholder="e.g. Main St shul"></label>
    <label>Address <input name="address" maxlength="200" placeholder="e.g. 12 Main St, Monsey"></label>
    <label>Code <span class="quiet">(1 to 6 digits; empty = the house number)</span> <input name="code" inputmode="numeric" maxlength="6"></label>
    <div class="actions"><button type="button" class="ghost" data-close>Cancel</button><button type="button" class="good" data-place-save>Save</button></div></form>
    <p class="quiet">Callers can then press this code on the phone for "from" or "to".</p>`);
}
async function savePlace() {
  const v = Object.fromEntries(new FormData($("#place-form")));
  const r = await act("/api/driver/places", { name: v.name, address: v.address, code: v.code }, { queueable: false });
  if (!r?.ok) return;
  info(`Saved. The code is ${r.code}.${r.found ? `\nGoogle found: ${r.found}` : ""}${r.warning ? `\n${r.warning}` : ""}`);
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

// A message to everyone: text phones get a text, call phones get a call that reads it out.
async function everyoneSheet() {
  let past = [];
  try { const r = await api("/api/driver/announcements"); if (r.ok) past = r.data; } catch { /* no signal */ }
  sheet(`<h2>Message to everyone</h2>
    <p class="quiet">Phones set to texts get a text. Phones set to calls get a call that reads it out.</p>
    <label>Write the message <textarea id="ev-text" rows="4" maxlength="500"></textarea></label>
    <button class="good big" data-everyone-send>Send to everyone</button>
    <button class="ghost big" data-close>Close</button>
    ${past.length ? `<h3>Sent before</h3>${past.map((a) => `<div class="card"><p>${esc(a.text)}</p><p class="quiet">${esc(new Date(a.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</p></div>`).join("")}` : ""}`);
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
  if (ds.ask) { const f = askDone; askDone = null; $("#sheet").hidden = true; f?.(ds.ask === "yes"); return; }
  if (ds.week != null) { week = Number(ds.week); render(); return; }
  if (ds.day) return daySheet(ds.day);
  if (ds.dayHours || ds.dayClosed) { schKind = ds.dayHours ? "hours" : "closed"; const d = ds.dayHours || ds.dayClosed; scheduleSheet({ from: d, to: d }); return; }
  if (ds.addRide != null) return addRideSheet();
  if (ds.rideSave != null) return saveRide();
  if (ds.addPlace != null) return addPlaceSheet();
  if (ds.placeSave != null) return savePlace();
  if (ds.proposeTyped) {
    const v = $("#propose-time")?.value;
    if (!v) { toast("Choose a time first."); return; }
    closeSheet();
    await act(`/api/driver/bookings/${ds.proposeTyped}/propose`, { minute: toMinute(v) }, { queueable: false, ok: "Sent to the caller" });
    return;
  }
  if (ds.tab || ds.tabGo) { closeSheet(); tab = ds.tab || ds.tabGo; reorder = null; render(); if (tab === "hours") loadSchedule(); return; }
  if (ds.schAdd != null) return scheduleSheet();
  if (ds.schKind) { schKind = ds.schKind; scheduleSheet(readSheet()); return; }
  if (ds.schSave != null) return saveSchedule();
  if (ds.brkAdd != null) return breakSheet(ds.brkAdd);
  if (ds.brkSave != null) return saveBreak();
  if (ds.brkRemove) {
    if (!(await ask("Remove this break?", "Remove", true))) return;
    const r = await act(`/api/driver/breaks/${ds.brkRemove}/remove`, {}, { queueable: false, ok: "Removed" });
    if (r) loadSchedule();
    return;
  }
  if (ds.schRemove) {
    if (!(await ask("Remove this change? Those days go back to the usual hours.", "Remove", true))) return;
    const r = await act(`/api/driver/schedule/${ds.schRemove}/remove`, {}, { queueable: false, ok: "Removed" });
    if (r) loadSchedule();
    return;
  }
  if (ds.status) {
    if (ds.status === "paused") return pauseSheet();
    if (ds.status === "offline" && !(await ask("Stop work? New rides will wait until you start again.", "Stop work", true))) return;
    await act("/api/driver/status", { status: ds.status }, { ok: ds.status === "online" ? "Started. Rides will come in" : "Stopped" });
    return;
  }
  if (ds.sharing) {
    const on = ds.sharing === "on";
    if (!on && !(await ask("Stop sharing your location? The office won't see where you are, and late notices are less exact.", "Stop sharing", true))) return;
    await act("/api/driver/sharing", { on }, { ok: on ? "Location shared again" : "Location not shared" });
    return;
  }
  if (ds.pause) { closeSheet(); await act("/api/driver/status", { status: "paused", minutes: Number(ds.pause) }, { ok: "Paused" }); return; }
  if (ds.act) {
    const id = ds.id;
    const names = { pickup: "Picked up", done: "Dropped off", no_show: "No-show", accept: "Taken", reject: "The caller is told" };
    if (ds.act === "no_show" && !(await ask("Nobody came? The seats are freed.", "No-show", true))) return;
    if (ds.act === "reject" && !(await ask("Can't take this ride? The caller gets a message.", "Can't take it", true))) return;
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
  if (ds.everyone != null) return everyoneSheet();
  if (ds.everyoneSend != null) {
    const text = $("#ev-text").value.trim();
    if (!text) { toast("Write the message first."); return; }
    if (!(await ask("Send this to everyone?", "Send"))) return;
    const r = await act("/api/driver/announce", { text }, { queueable: false });
    if (r) toast(`Sent to ${r.phones} phones`);
    return;
  }
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
  if (ds.update != null) { const app = newerApp(); if (app) native.update(app.url); return; }
  if (ds.refresh != null) { await load(); toast("Loaded"); return; }
  if (ds.signout != null) {
    if (!(await ask("Sign out?", "Sign out", true))) return;
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
