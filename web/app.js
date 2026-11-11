// The admin dashboard: plain JavaScript, one page, talking to /api/admin.
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let main = $("#main");

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body !== undefined ? { "content-type": "application/json" } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") { showLogin(); throw new Error("signed out"); }
  if (!res.ok) {
    const err = new Error(data.error || (data.errors || []).map(errorText).join(", ") || `Error ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

const ERRORS = {
  not_registered: "That phone number isn't approved", not_today: "Only same-day rides", outside_hours: "Outside service hours",
  in_past: "That time already passed", bad_window: "Choose a 15 or 30 minute window", no_seats: "No fitting seats at that time",
  no_riders: "Enter how many men and women", no_pickup: "Choose a pickup place", no_dropoff: "Choose a destination",
  return_before_pickup: "The return must be after the pickup", return_outside_hours: "The return is outside service hours",
  wrong_status: "Not possible in this ride's status", not_pending: "This ride isn't waiting for an answer",
  no_time: "The route can't reach it in time without making others late", too_far: "Longer than the trip limit",
  closed: "No rides today (schedule)", riders_count: "More people ticked than men and women", unknown_passenger: "Unknown person",
  bad_people: "More people ticked than men and women",
};
const errorText = (c) => ERRORS[c] || c;

function toast(msg, ms = 3000) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}
// ok: the message on success. A saved address can come back with a warning from the map check: shown longer.
async function act(fn, ok) {
  try {
    const r = await fn();
    if (r?.warning) toast(`${ok ? `${ok}. ` : ""}${r.warning}`, 10000);
    else if (ok) toast(r?.found ? `${ok}: ${r.found}${r.code ? ` (code ${r.code})` : ""}` : ok, r?.found ? 6000 : 3000);
    return true;
  } catch (e) { if (e.message !== "signed out") toast(e.message); return false; }
}

const minuteText = (m) => {
  if (m == null) return "";
  const h24 = Math.floor(m / 60);
  return `${((h24 + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
};
const timeToMinute = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
const minuteToTime = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const STATUS = { pending: "Waiting for driver", proposed: "New time offered", accepted: "Accepted", picked_up: "On board", completed: "Completed", rejected: "Rejected", cancelled: "Cancelled", no_show: "No-show" };
// The admin's priority level on a ride or person: a badge for High and Top, nothing for normal.
const prioBadge = (x) => (x?.priority > 0 ? ` <span class="prio p${x.priority}">${esc(x.priority_label || "High")}</span>` : "");
const PRIO_LEVELS = { 1: "High", 2: "Top" };
const whenText = (p) => {
  const t = (v) => new Date(`${v}:00`).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (!p.starts_at && !p.ends_at) return "Always";
  if (p.ends_at && p.ends_at < new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" }).slice(0, 16).replace(" ", "T")) return `Ended ${t(p.ends_at)}`;
  return `${p.starts_at ? `From ${t(p.starts_at)}` : "Now"}${p.ends_at ? ` until ${t(p.ends_at)}` : " on"}`;
};
const riders = (b) => [b.men && `${b.men} ${b.men === 1 ? "man" : "men"}`, b.women && `${b.women} ${b.women === 1 ? "woman" : "women"}`].filter(Boolean).join(", ") + (b.together ? " (may sit together)" : "");

// ---------- login ----------
function showLogin() { $("#app").hidden = true; $("#login").hidden = false; }
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api("/api/login", { method: "POST", body: { email: f.get("email"), password: f.get("password") } });
    $("#login-error").textContent = "";
    start();
  } catch (err) { $("#login-error").textContent = err.message; }
});
$("#logout").addEventListener("click", async () => { await api("/api/logout", { method: "POST", body: {} }); showLogin(); });

// ---------- tabs ----------
const TABS = { today, pending, families, places, schedule, announce, reports, settings, activity, feedback };
let current = "today";
$("#tabs").addEventListener("click", (e) => { const t = e.target.dataset.tab; if (t) open(t); });
function open(tab) {
  current = tab;
  try { localStorage.setItem("dd.tab", tab); } catch {}
  for (const b of $("#tabs").children) b.classList.toggle("on", b.dataset.tab === tab);
  // A fresh element each time, so listeners from the last tab never pile up.
  const fresh = main.cloneNode(false);
  main.replaceWith(fresh);
  main = fresh;
  main.innerHTML = '<p class="quiet">Loading…</p>';
  TABS[tab]().catch((e) => { if (e.message !== "signed out") main.innerHTML = `<p class="error">${esc(e.message)}</p>`; });
}

async function start() {
  const me = await api("/api/admin/me").catch(() => null);
  if (!me) return showLogin();
  $("#me").textContent = me.email;
  $("#login").hidden = true;
  $("#app").hidden = false;
  let tab = "today";
  try { tab = localStorage.getItem("dd.tab") || tab; } catch {}
  open(TABS[tab] ? tab : "today");
}

// ---------- bookings ----------
function bookingTable(rows, { showDay = false } = {}) {
  if (!rows.length) return '<p class="quiet">No rides.</p>';
  return `<div class="wrap"><table><thead><tr>${showDay ? "<th>Day</th>" : ""}<th>Pickup</th><th>Who</th><th>From → To</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((b) => `
    <tr data-id="${esc(b.id)}">
      ${showDay ? `<td>${esc(b.day)}</td>` : ""}
      <td>${minuteText(b.pickup_minute)}<div class="quiet">${b.window_minutes}-min window${b.proposed_minute != null ? `<br>offered ${minuteText(b.proposed_minute)}` : ""}</div></td>
      <td>${esc(b.rider_name || "")}${prioBadge(b)}<div class="quiet">${esc(riders(b))}<br>${esc(b.booked_by_phone)}</div></td>
      <td>${esc(b.pickup_address)}<br>→ ${esc(b.dropoff_address)}${b.return_of ? '<div class="quiet">return trip</div>' : ""}</td>
      <td><span class="status ${esc(b.status)}">${esc(STATUS[b.status] || b.status)}</span></td>
      <td class="actions">${bookingButtons(b)}</td>
    </tr>`).join("")}</tbody></table></div>`;
}
function bookingButtons(b) {
  const btn = (a, label, cls = "ghost") => `<button class="${cls}" data-act="${a}">${label}</button>`;
  const s = b.status;
  return [
    ["pending", "proposed"].includes(s) && btn("accept", "Accept", ""),
    s === "pending" && btn("propose", "Offer time"),
    ["pending", "proposed"].includes(s) && btn("reject", "Reject", "danger"),
    s === "accepted" && btn("pickup", "Picked up"),
    ["accepted", "picked_up"].includes(s) && btn("done", "DONE", ""),
    s === "accepted" && btn("no_show", "No-show", "danger"),
    ["pending", "proposed", "accepted"].includes(s) && btn("edit", "Change address"),
    ["pending", "proposed", "accepted"].includes(s) && btn("cancel", "Cancel", "danger"),
  ].filter(Boolean).join("");
}
function wireBookings(el, reload) {
  el.addEventListener("click", async (e) => {
    const a = e.target.dataset.act;
    const id = e.target.closest("tr")?.dataset.id;
    if (!a || !id) return;
    if (a === "edit") {
      const b = await api(`/api/admin/bookings/${id}`);
      const pickup = prompt("Pickup address", b.pickup_address);
      if (pickup == null) return;
      const dropoff = prompt("Destination", b.dropoff_address);
      if (dropoff == null) return;
      if (await act(async () => {
        const r = await api(`/api/admin/bookings/${id}`, { method: "PATCH", body: { pickup_address: pickup, dropoff_address: dropoff } });
        if (r.warning) alert(r.warning);
      }, "Changed")) reload();
      return;
    }
    let body = {};
    if (a === "accept") {
      let p;
      try { p = await api(`/api/admin/bookings/${id}/preview`); } catch (err) { toast(err.message); return; }
      const names = Object.fromEntries((await api("/api/admin/bookings")).map((b) => [b.id, b.rider_name || b.booked_by_phone]));
      const moves = Object.entries(p.shifts).flatMap(([bid, k]) => Object.entries(k).map(([kind, [from, to]]) =>
        `  ${names[bid] || "a rider"}: ${kind === "pickup" ? "pickup" : "drop-off"} ${minuteText(from)} → ${minuteText(to)}`));
      const blocks = (p.blocks || []).map((x) => `  ${x.rider_name || "a rider"} (${x.label} priority, ${minuteText(x.window[0])})`);
      const text = (blocks.length ? `WAIT: accepting this leaves no room for a higher-priority ride that is also waiting:\n${blocks.join("\n")}\nHigher priority should go first.\n\n` : "") +
        `Pickup about ${minuteText(p.eta)}.\nDriving today: ${p.before.driveMinutes} → ${p.after.driveMinutes} minutes.` +
        (moves.length ? `\nTimes that move:\n${moves.join("\n")}` : "\nNobody else's time moves.") +
        (p.after.estimated ? "\n(Some drive times are estimates.)" : "") + (blocks.length ? "\n\nAccept this ride anyway?" : "\n\nAccept this ride?");
      if (!confirm(text)) return;
    }
    if (a === "propose") {
      const t = prompt("New pickup time (for example 14:30)");
      if (!t) return;
      body = { minute: timeToMinute(t) };
    }
    if (["cancel", "reject", "no_show"].includes(a) && !confirm("Are you sure?")) return;
    if (await act(() => api(`/api/admin/bookings/${id}/${a}`, { method: "POST", body }), "Done")) reload();
  });
}

// The driver's status and where they were last seen.
const ago = (iso) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
};
const DRIVER_STATUS = { online: "Online", paused: "Paused", offline: "Offline" };
function driverLine(d) {
  const where = d.last_lat != null ? ` · <a href="https://www.google.com/maps/search/?api=1&query=${d.last_lat},${d.last_lng}" target="_blank" rel="noopener">seen ${ago(d.last_seen_at)}</a>` : " · no location yet";
  const until = d.status === "paused" && d.paused_until ? ` until ${new Date(d.paused_until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
  return `<b>${esc(d.name)}</b>: ${DRIVER_STATUS[d.status] || esc(d.status)}${until}${where}`;
}

async function today() {
  const [rows, fams, route, drivers] = await Promise.all([api("/api/admin/bookings"), api("/api/admin/households"), api("/api/admin/route"), api("/api/admin/drivers")]);
  const phones = fams.flatMap((h) => h.phones.map((p) => ({ ...p, family: h.name, person: h.passengers.find((x) => x.id === p.passenger_id)?.name, places: h.places })));
  const shared = await api("/api/admin/places");
  main.innerHTML = `
    <div class="card"><h2>Today's route <button id="recalc" class="ghost">Recalculate</button></h2>
      ${drivers.map((d) => `<p>${driverLine(d)}</p>`).join("") || '<p class="quiet">No driver yet (Settings).</p>'}${routeCard(route)}</div>
    <div class="card"><h2>Today's rides</h2><div id="list">${bookingTable(rows)}</div></div>
    <div class="card"><h2>Book a ride for a caller</h2>
      <form id="book">
        <div class="row">
          <label>Caller's phone <select name="phone" required>${phones.map((p) => `<option value="${esc(p.number)}">${esc(p.family)}${p.person ? ` (${esc(p.person)})` : ""}: ${esc(phoneText(p.number))}</option>`).join("")}</select></label>
          <label>Rider's name (empty = the people below) <input name="riderName"></label>
        </div>
        <div class="row people-pick" id="book-people"></div>
        <div class="row">
          <label><span class="people-only">Other </span>men <input name="men" type="number" min="0" max="7" value="0"></label>
          <label><span class="people-only">Other </span>women <input name="women" type="number" min="0" max="6" value="0"></label>
          <label><input name="together" type="checkbox"> Men and women may sit together</label>
        </div>
        <div class="row">
          <label>From <select name="from"></select></label>
          <label hidden>From address (this ride only) <input name="fromAddress" placeholder="12 Main St, Monsey NY"></label>
          <label>To <select name="to"></select></label>
          <label hidden>To address (this ride only) <input name="toAddress" placeholder="12 Main St, Monsey NY"></label>
        </div>
        <div class="row">
          <label>Pickup time (empty = now) <input name="time" type="time"></label>
          <label>Window <select name="window"><option value="15">15 minutes</option><option value="30">30 minutes</option></select></label>
          <label>Return pickup (optional) <input name="ret" type="time"></label>
        </div>
        <button>Book</button>
      </form>
    </div>`;
  const reload = () => open("today");
  wireBookings($("#list"), reload);
  // From and To list the caller's family places and the shared ones, plus "another address" typed for this ride only.
  const form = $("#book");
  const fillPlaces = () => {
    const ph = phones.find((p) => p.number === form.phone.value);
    const mine = shared.filter((p) => !p.household_id || p.household_id === ph?.household_id);
    for (const end of ["from", "to"]) {
      const was = form[end].options.length ? form[end].value : null; // null on the first fill: start on a saved place
      form[end].innerHTML = `${placeOptions(mine)}<option value="">Another address (this ride only)…</option>`;
      if (was != null && [...form[end].options].some((o) => o.value === was)) form[end].value = was;
      showAddress(end);
    }
  };
  const showAddress = (end) => {
    const other = form[end].value === "";
    form[`${end}Address`].closest("label").hidden = !other;
    form[`${end}Address`].required = other;
  };
  form.phone.addEventListener("change", fillPlaces);
  form.from.addEventListener("change", () => showAddress("from"));
  form.to.addEventListener("change", () => showAddress("to"));
  fillPlaces();
  // Who is coming: the caller's family and relatives, ticked one by one.
  let bookPeople = [];
  const loadPeople = async () => {
    const phone = $("#book [name=phone]").value;
    bookPeople = phone ? await api(`/api/admin/phones/${encodeURIComponent(phone)}/people`).catch(() => []) : [];
    $("#book-people").innerHTML = bookPeople.length ? `<span class="quiet">Who is coming:</span> ${bookPeople.map((p) => `<label class="tick"><input type="checkbox" name="rider" value="${esc(p.id)}"> ${esc(p.name)}</label>`).join(" ")}` : "";
    for (const s of main.querySelectorAll(".people-only")) s.hidden = !bookPeople.length;
  };
  $("#book [name=phone]")?.addEventListener("change", loadPeople);
  loadPeople();
  $("#book").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    // The people ticked count as men and women too; the number fields are everyone else.
    const picked = bookPeople.filter((p) => f.getAll("rider").includes(p.id));
    const body = {
      phone: f.get("phone"), riderName: f.get("riderName"), riders: picked.map((p) => p.id),
      men: Number(f.get("men")) + picked.filter((p) => p.gender === "m").length,
      women: Number(f.get("women")) + picked.filter((p) => p.gender === "f").length,
      together: !!f.get("together"),
      pickup: f.get("from") ? { placeId: f.get("from") } : { address: f.get("fromAddress") },
      dropoff: f.get("to") ? { placeId: f.get("to") } : { address: f.get("toAddress") },
      pickupMinute: f.get("time") ? timeToMinute(f.get("time")) : null, window: Number(f.get("window")),
      returnMinute: f.get("ret") ? timeToMinute(f.get("ret")) : undefined,
    };
    try {
      const r = await api("/api/admin/bookings", { method: "POST", body });
      toast(`Ride requested (pickup about ${minuteText(r.etas[r.bookings[0].id])}); it waits for the driver`);
      reload();
    } catch (err) {
      if (err.message === "signed out") return;
      const sug = err.data?.suggestions || [];
      toast(err.message + (sug.length ? `. Times that fit: ${sug.map(minuteText).join(", ")}` : ""));
    }
  });
  $("#recalc").addEventListener("click", async () => { if (await act(() => api("/api/admin/route/refresh", { method: "POST", body: {} }), "Route recalculated")) reload(); });
}

function routeCard(r) {
  if (!r.stops.length) return '<p class="quiet">No accepted rides yet.</p>';
  const seatText = (seats) => Object.entries(seats || {}).map(([row, x]) => `${{ front: "front", row2: "row 2", row3: "row 3" }[row] || row}: ${[x.men && `${x.men}m`, x.women && `${x.women}w`].filter(Boolean).join(" ")}`).join(", ");
  const freeAfter = (i) => {
    const s = r.seatsByStop[i];
    return s ? s.rows.map((x) => `${{ front: "F", row2: "2", row3: "3" }[x.row] || x.row}:${x.free}`).join(" ") : "";
  };
  return `<p class="quiet">${r.stops.length} stops, about ${r.driveMinutes} minutes of driving${r.estimated ? " (some drive times are estimates)" : ""}.</p>
    <div class="wrap"><table><thead><tr><th>Time</th><th>Stop</th><th>Who</th><th>Address</th><th>Seats</th><th>Free after (front, 2, 3)</th></tr></thead><tbody>${r.stops.map((s, i) => {
      const late = s.window && s.arrive > s.window[1];
      return `<tr><td>${minuteText(s.arrive)}${s.window ? `<div class="quiet${late ? " error" : ""}">window ${minuteText(s.window[0])}–${minuteText(s.window[1])}${late ? ", late" : ""}</div>` : ""}</td>
        <td>${s.kind === "pickup" ? "Pick up" : "Drop off"}</td><td>${esc(s.rider_name || "")}<div class="quiet">${esc(riders(s))}</div></td>
        <td>${esc(s.address)}</td><td>${esc(seatText(s.seats))}</td><td class="quiet">${esc(freeAfter(i))}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}
const placeOptions = (places) => places.map((p) => `<option value="${esc(p.id)}">${esc(p.code)} ${esc(p.name)}${p.household_id ? "" : " (shared)"}</option>`).join("");

async function pending() {
  const rows = [...(await api("/api/admin/bookings?status=pending")), ...(await api("/api/admin/bookings?status=proposed"))]
    .sort((a, b) => b.day.localeCompare(a.day) || (b.priority || 0) - (a.priority || 0) || a.pickup_minute - b.pickup_minute);
  main.innerHTML = `<div class="card"><h2>Waiting for the driver</h2><div id="list">${bookingTable(rows, { showDay: true })}</div></div>`;
  wireBookings($("#list"), () => open("pending"));
}

// ---------- families ----------
// Which families are open and what the search says, kept across reloads of the tab.
const famState = { open: new Set(), q: "" };
try { famState.open = new Set(JSON.parse(localStorage.getItem("dd.famOpen") || "[]")); famState.q = sessionStorage.getItem("dd.famQ") || ""; } catch {}
const saveFamState = () => { try { localStorage.setItem("dd.famOpen", JSON.stringify([...famState.open])); sessionStorage.setItem("dd.famQ", famState.q); } catch {} };
// A phone is the whole family's, or one person's.
const ownerOptions = (h, chosen) => `<option value="">Whole family</option>${h.passengers.map((p) => `<option value="${esc(p.id)}" ${p.id === chosen ? "selected" : ""}>${esc(p.name)}</option>`).join("")}`;
// +18455551234 shown as 845-555-1234.
const phoneText = (n) => String(n).replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// Everything a search can match in a family: its name, people, phones (digits too) and places.
const famText = (h) => [h.name, ...h.passengers.flatMap((p) => [p.name, p.spoken, p.notes]), ...h.phones.flatMap((p) => [p.number, phoneText(p.number)]),
  ...h.places.flatMap((p) => [p.code, p.name, p.spoken, p.address])].join(" ").toLowerCase();

async function families() {
  const [fams, prios, rel] = await Promise.all([api("/api/admin/households"), api("/api/admin/priorities"), api("/api/admin/relations")]);
  fams.sort((a, b) => a.name.localeCompare(b.name));
  // Everyone, by family, for the "related to" list.
  const everyone = `${fams.map((f) => `<optgroup label="${esc(f.name)}">${f.passengers.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</optgroup>`).join("")}`;
  main.innerHTML = `
    <div class="card toolbar">
      <input id="fam-q" type="search" placeholder="Search families, people, phones, places…" value="${esc(famState.q)}" autocomplete="off">
      <button class="ghost" id="fam-expand">Open all</button><button class="ghost" id="fam-collapse">Close all</button>
      <details class="add"><summary>+ Add a family</summary><form id="add-fam" class="row"><label>Family name <input name="name" required></label><button>Add</button></form></details>
    </div>
    <p class="quiet" id="fam-count"></p>
    ${fams.map((h) => {
      const hp = prios.filter((x) => x.household_id === h.id);
      const top = hp.reduce((m, x) => Math.max(m, x.level), 0);
      return `
      <details class="card fam" data-hh="${esc(h.id)}" data-text="${esc(famText(h))}" ${famState.open.has(h.id) ? "open" : ""}>
        <summary><span class="fam-name">${esc(h.name)}</span>${top ? ` <span class="prio p${top}">${esc(PRIO_LEVELS[top])}</span>` : ""}
          <span class="quiet">${plural(h.passengers.length, "person", "people")} · ${plural(h.phones.length, "phone", "phones")} · ${plural(h.places.length, "place", "places")}</span></summary>
        <div class="fam-body">
        <div class="row fam-tools"><button class="ghost" data-act="rename">Rename</button> <button class="danger" data-act="remove-fam">Remove family</button></div>
        <h3>People</h3>
        <table><tbody>${h.passengers.map((p) => `<tr data-ps="${esc(p.id)}"><td>${esc(p.name)}${p.spoken ? `<div class="quiet" dir="rtl">${esc(p.spoken)}</div>` : ""}</td><td>${p.gender === "m" ? "Man" : "Woman"}</td><td class="quiet">${esc(p.notes)}</td>
          <td class="actions"><button class="ghost" data-act="edit-ps">Edit</button><button class="danger" data-act="remove-ps">Remove</button></td></tr>`).join("") || '<tr><td class="quiet">No one yet.</td></tr>'}</tbody></table>
        <details class="add"><summary>+ Add a person</summary><form class="row" data-form="ps"><label>Name <input name="name" required></label>
          <label>Name in Yiddish (said on the phone) <input name="spoken" dir="rtl"></label>
          <label>Man or woman <select name="gender"><option value="m">Man</option><option value="f">Woman</option></select></label>
          <label>Notes for the driver <input name="notes"></label><button>Add person</button></form></details>
        <h3>Approved phones</h3>
        <table><tbody>${h.phones.map((p) => `<tr data-ph="${esc(p.number)}"><td>${esc(phoneText(p.number))}</td>
          <td><select data-act="owner" title="Whose phone: on a person's phone, 'for myself' books that person">${ownerOptions(h, p.passenger_id)}</select></td>
          <td><select data-act="notify">${["both", "text", "voice"].map((n) => `<option value="${n}" ${p.notify === n ? "selected" : ""}>${n === "both" ? "Texts and calls" : n === "text" ? "Texts only" : "Calls only"}</option>`).join("")}</select></td>
          <td class="actions"><button class="danger" data-act="remove-ph">Remove</button></td></tr>`).join("") || '<tr><td class="quiet">No phones yet.</td></tr>'}</tbody></table>
        <details class="add"><summary>+ Add a phone</summary><form class="row" data-form="ph"><label>Phone number <input name="number" required placeholder="845-555-1234"></label>
          <label>Whose phone <select name="passengerId">${ownerOptions(h, null)}</select></label>
          <label>Messages by <select name="notify"><option value="both">Texts and calls</option><option value="text">Texts only</option><option value="voice">Calls only</option></select></label><button>Add phone</button></form></details>
        <h3>Saved places</h3>
        <table><tbody>${h.places.map((p) => placeRow(p)).join("") || '<tr><td class="quiet">No places yet.</td></tr>'}</tbody></table>
        <details class="add"><summary>+ Add a place</summary><form class="row" data-form="pl"><label>Code on the phone <input name="code" pattern="\\d{1,2}" maxlength="2" placeholder="auto" title="1 or 2 digits, or empty for the next free code"></label>
          <label>Kind <select name="kind"><option value="home">Home</option><option value="work">Work</option><option value="other">Other</option></select></label>
          <label>Name <input name="name" required></label><label>Name in Yiddish (said on the phone) <input name="spoken" dir="rtl"></label>
          <label>Address <input name="address" required placeholder="12 Main St, Monsey NY"></label><button>Add place</button></form></details>
        <h3>Relations and seating</h3>
        ${relationTable(h, rel)}
        <details class="add"><summary>+ Add a relation or seat rule</summary>
        <p class="quiet">"May sit next to each other" lets a man and woman share a row (for example husband and wife, even on separate rides). "Must not sit next to each other" keeps two people in different rows. Callers can also name relatives from other families when they book.</p>
        <form class="row" data-form="rel"><label>Person <select name="aId" required>${h.passengers.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></label>
          <label>Relation <select name="kind">${Object.entries(rel.kinds).map(([v, n]) => `<option value="${v}">${esc(n)}</option>`).join("")}</select></label>
          <label>With <select name="bId" required>${everyone}</select></label>
          <label>Seating <select name="seating">${Object.entries(rel.seating).map(([v, n]) => `<option value="${v}" ${v === "together" ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
          <label>Note (optional) <input name="note"></label><button>Save</button></form></details>
        <h3>Priority</h3>
        <table><tbody>${hp.map((x) => `<tr data-pri="${esc(x.id)}"><td>${esc(x.passenger_name || "Whole family")}</td>
          <td><span class="prio p${x.level}">${esc(x.label)}</span></td><td>${esc(whenText(x))}</td><td class="quiet">${esc(x.note)}</td>
          <td class="actions"><button class="danger" data-act="remove-pri">Remove</button></td></tr>`).join("") || '<tr><td class="quiet">Normal priority.</td></tr>'}</tbody></table>
        <details class="add"><summary>+ Add a priority</summary>
        <p class="quiet">Higher priority goes first when rides compete for the same seats or time. It never moves a ride the driver already accepted.</p>
        <form class="row" data-form="pri"><label>Who <select name="passengerId"><option value="">Whole family</option>${h.passengers.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></label>
          <label>Level <select name="level">${Object.entries(PRIO_LEVELS).map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select></label>
          <label>From (empty = now) <input name="from" type="datetime-local"></label>
          <label>Until (empty = always) <input name="to" type="datetime-local"></label>
          <label>Note (optional) <input name="note" placeholder="for example: doctor visits"></label><button>Add priority</button></form></details>
        </div>
      </details>`;
    }).join("") || '<p class="quiet">No families yet.</p>'}`;

  const cards = [...main.querySelectorAll("details.fam")];
  const filter = () => {
    const words = famState.q.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const c of cards) { const hit = words.every((w) => c.dataset.text.includes(w)); c.hidden = !hit; if (hit) shown++; }
    $("#fam-count").textContent = words.length ? `${shown} of ${plural(cards.length, "family", "families")} match` : plural(cards.length, "family", "families");
  };
  filter();
  $("#fam-q").addEventListener("input", (e) => { famState.q = e.target.value; saveFamState(); filter(); });
  $("#fam-q").addEventListener("keydown", (e) => {
    // Enter opens the only match; Escape clears the search.
    if (e.key === "Escape") { e.target.value = ""; famState.q = ""; saveFamState(); filter(); }
    if (e.key === "Enter") { const vis = cards.filter((c) => !c.hidden); if (vis.length === 1) vis[0].open = true; }
  });
  for (const c of cards) c.addEventListener("toggle", () => { famState.open[c.open ? "add" : "delete"](c.dataset.hh); saveFamState(); });
  const setAll = (o) => { for (const c of cards) if (!c.hidden) c.open = o; };
  $("#fam-expand").addEventListener("click", () => setAll(true));
  $("#fam-collapse").addEventListener("click", () => setAll(false));

  $("#add-fam").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (await act(() => api("/api/admin/households", { method: "POST", body: { name: new FormData(e.target).get("name") } }), "Family added")) open("families");
  });
  main.addEventListener("submit", async (e) => {
    const kind = e.target.dataset.form;
    if (!kind) return;
    e.preventDefault();
    const hh = e.target.closest("[data-hh]").dataset.hh;
    const f = Object.fromEntries(new FormData(e.target));
    const path = { ps: "passengers", ph: "phones", pl: "places", pri: "priorities", rel: "relations" }[kind];
    if (await act(() => api(`/api/admin/${path}`, { method: "POST", body: { ...f, householdId: hh } }), kind === "pl" ? "Place added" : "Added")) open("families");
  });
  main.addEventListener("change", async (e) => {
    // Close family usually may sit together: suggest it when the relation is picked.
    if (e.target.name === "kind" && e.target.closest("[data-form=rel]")) {
      e.target.form.seating.value = ["spouse", "parent", "sibling", "grandparent"].includes(e.target.value) ? "together" : "normal";
      return;
    }
    const a = e.target.dataset.act;
    if (a !== "notify" && a !== "owner") return;
    const number = e.target.closest("[data-ph]").dataset.ph;
    const body = a === "notify" ? { notify: e.target.value } : { passengerId: e.target.value };
    await act(() => api(`/api/admin/phones/${encodeURIComponent(number)}`, { method: "PATCH", body }), "Saved");
  });
  main.addEventListener("click", async (e) => {
    const a = e.target.dataset.act;
    if (!a || a === "notify" || a === "owner") return;
    const hh = e.target.closest("[data-hh]")?.dataset.hh;
    const ps = e.target.closest("[data-ps]")?.dataset.ps;
    const ph = e.target.closest("[data-ph]")?.dataset.ph;
    const pl = e.target.closest("[data-pl]")?.dataset.pl;
    const pri = e.target.closest("[data-pri]")?.dataset.pri;
    const rl = e.target.closest("[data-rel]")?.dataset.rel;
    let done = false;
    if (a === "remove-rel" && confirm("Remove this relation?")) done = await act(() => api(`/api/admin/relations/${rl}`, { method: "DELETE" }), "Removed");
    if (a === "remove-pri" && confirm("Remove this priority?")) done = await act(() => api(`/api/admin/priorities/${pri}`, { method: "DELETE" }), "Removed");
    if (a === "rename") { const n = prompt("New family name"); if (n) done = await act(() => api(`/api/admin/households/${hh}`, { method: "PATCH", body: { name: n } })); }
    if (a === "remove-fam" && confirm("Remove this family and all its phones?")) done = await act(() => api(`/api/admin/households/${hh}`, { method: "DELETE" }));
    if (a === "edit-ps") {
      const spoken = prompt("Name in Yiddish, as the phone says it (empty = keep)");
      const notes = prompt("Notes for the driver (empty = keep)");
      const body = {};
      if (spoken) body.spoken = spoken;
      if (notes) body.notes = notes;
      if (Object.keys(body).length) done = await act(() => api(`/api/admin/passengers/${ps}`, { method: "PATCH", body }));
    }
    if (a === "remove-ps" && confirm("Remove this person?")) done = await act(() => api(`/api/admin/passengers/${ps}`, { method: "DELETE" }));
    if (a === "remove-ph" && confirm("Remove this phone? It won't be able to book.")) done = await act(() => api(`/api/admin/phones/${encodeURIComponent(ph)}`, { method: "DELETE" }));
    if (a === "edit-pl") done = await editPlace(pl);
    if (a === "remove-pl" && confirm("Remove this place?")) done = await act(() => api(`/api/admin/places/${pl}`, { method: "DELETE" }));
    if (done) open(current);
  });
}
// The relations of a family's people, with their seat rule.
function relationTable(h, rel) {
  const mine = new Set(h.passengers.map((p) => p.id));
  const rows = rel.relations.filter((r) => mine.has(r.a_id) || mine.has(r.b_id));
  const seat = (r) => (r.seating === "normal" ? `<span class="quiet">${esc(r.seating_label)}</span>` : `<strong>${esc(r.seating_label)}</strong>`);
  return `<table><tbody>${rows.map((r) => `<tr data-rel="${esc(r.id)}"><td>${esc(r.a_name)} and ${esc(r.b_name)}</td><td>${esc(r.kind_label)}</td><td>${seat(r)}</td><td class="quiet">${esc(r.note)}</td>
    <td class="actions"><button class="danger" data-act="remove-rel">Remove</button></td></tr>`).join("") || '<tr><td class="quiet">None yet.</td></tr>'}</tbody></table>`;
}
const placeRow = (p) => `<tr data-pl="${esc(p.id)}"><td>${esc(p.code)}</td><td>${esc(p.name)}${p.spoken ? `<div class="quiet" dir="rtl">${esc(p.spoken)}</div>` : ""}</td><td>${esc(p.address)}</td>
  <td class="actions"><button class="ghost" data-act="edit-pl">Edit</button><button class="danger" data-act="remove-pl">Remove</button></td></tr>`;
async function editPlace(id) {
  const address = prompt("New address (empty = keep)");
  const spoken = prompt("Name in Yiddish, as the phone says it (empty = keep)");
  const body = {};
  if (address) body.address = address;
  if (spoken) body.spoken = spoken;
  if (!Object.keys(body).length) return false;
  return act(() => api(`/api/admin/places/${id}`, { method: "PATCH", body }), "Saved");
}

// ---------- shared places ----------
async function places() {
  const all = (await api("/api/admin/places")).filter((p) => !p.household_id);
  main.innerHTML = `<div class="card"><h2>Shared places</h2><p class="quiet">Places every family can use, like shuls and stores. Family homes are under Families.</p>
    <table><tbody>${all.map(placeRow).join("") || '<tr><td class="quiet">None yet.</td></tr>'}</tbody></table>
    <form class="row" id="add-pl"><label>Code on the phone <input name="code" pattern="\\d{1,2}" maxlength="2" placeholder="auto" title="1 or 2 digits, or empty for the next free code"></label>
      <label>Name <input name="name" required></label><label>Name in Yiddish (said on the phone) <input name="spoken" dir="rtl"></label>
      <label>Address <input name="address" required placeholder="12 Main St, Monsey NY"></label><button>Add place</button></form></div>`;
  $("#add-pl").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (await act(() => api("/api/admin/places", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }), "Place added")) open("places");
  });
  main.addEventListener("click", async (e) => {
    const a = e.target.dataset.act;
    const pl = e.target.closest("[data-pl]")?.dataset.pl;
    let done = false;
    if (a === "edit-pl") done = await editPlace(pl);
    if (a === "remove-pl" && confirm("Remove this place?")) done = await act(() => api(`/api/admin/places/${pl}`, { method: "DELETE" }));
    if (done) open("places");
  });
}

// ---------- schedule ----------
// Other hours, or no rides, for a day or a range of days. Callers hear today's hours and the changes coming up.
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Shabbos"];
const dayText = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const hoursText = (h) => (h.closed ? "No rides" : `${minuteText(h.openMinute)} – ${minuteText(h.closeMinute)}`);
function changeText(c) {
  const days = c.from === c.to ? dayText(c.from) : `${dayText(c.from)} to ${dayText(c.to)}`;
  const only = c.weekdays ? `, only ${c.weekdays.map((d) => WEEKDAY_NAMES[d]).join(", ")}` : "";
  return `${days}${only}: ${hoursText(c)}`;
}
async function schedule() {
  const v = await api("/api/admin/schedule");
  const first = v.days[0].day;
  main.innerHTML = `
    <div class="card"><h2>Next two weeks</h2>
      <p class="quiet">Usual hours ${minuteText(v.usual.openMinute)} – ${minuteText(v.usual.closeMinute)} (change them under Settings). Callers hear today's hours when they're different, and can press 4 to hear the changes coming up.</p>
      <table><tbody>${v.days.map((d) => `<tr><td>${esc(dayText(d.day))}${d.day === first ? " (today)" : ""}</td>
        <td>${d.changed ? `<b>${esc(hoursText(d))}</b>` : esc(hoursText(d))}</td><td class="quiet">${d.changed ? "changed" : ""}</td></tr>`).join("")}</tbody></table></div>
    <div class="card"><h2>Change the schedule</h2><form id="sch">
      <div class="row"><label>First day <input type="date" name="from" value="${first}" min="${first}" required></label>
        <label>Last day (empty = one day) <input type="date" name="to" min="${first}"></label></div>
      <div class="row"><label><input type="radio" name="kind" value="hours" checked style="display:inline;width:auto"> Other hours</label>
        <label><input type="radio" name="kind" value="closed" style="display:inline;width:auto"> No rides</label></div>
      <div class="row" id="sch-hours"><label>From <input type="time" name="open" value="${minuteToTime(v.usual.openMinute)}"></label>
        <label>Until <input type="time" name="close" value="${minuteToTime(v.usual.closeMinute)}"></label></div>
      <p class="quiet">Only on some weekdays (none checked = every day in the range):
        ${WEEKDAY_NAMES.map((n, i) => `<label style="display:inline-block;margin-right:10px"><input type="checkbox" name="wd" value="${i}" style="display:inline;width:auto"> ${n}</label>`).join("")}</p>
      <label>Note (only you and the driver see it) <input name="note" maxlength="200"></label>
      <button>Save</button></form></div>
    <div class="card"><h2>Changes</h2>${v.changes.length ? `<table><tbody>${v.changes.map((c) => `<tr data-ch="${esc(c.id)}">
      <td>${esc(changeText(c))}${c.note ? `<div class="quiet">${esc(c.note)}</div>` : ""}</td><td class="quiet">${esc(c.createdBy.replace(/^(admin|driver):/, ""))}</td>
      <td class="actions"><button class="danger" data-act="rm-ch">Remove</button></td></tr>`).join("")}</tbody></table>
      <p class="quiet">When changes overlap, the newest one counts.</p>` : '<p class="quiet">No changes. Every day has the usual hours.</p>'}</div>`;
  const form = $("#sch");
  form.addEventListener("change", () => { $("#sch-hours").hidden = form.kind.value === "closed"; });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const closed = f.get("kind") === "closed";
    let r;
    const ok = await act(async () => {
      r = await api("/api/admin/schedule", { method: "POST", body: {
        from: f.get("from"), to: f.get("to") || f.get("from"), closed, weekdays: f.getAll("wd").map(Number), note: f.get("note"),
        ...(closed ? {} : { openMinute: timeToMinute(f.get("open")), closeMinute: timeToMinute(f.get("close")) }),
      } });
    }, "Saved");
    if (!ok) return;
    if (r.affected?.length) {
      alert(`${r.affected.length} ride${r.affected.length > 1 ? "s are" : " is"} already booked outside the new hours. They were not cancelled:\n\n` +
        r.affected.map((b) => `${dayText(b.day)} ${minuteText(b.pickup_minute)}  ${b.rider_name}  (${STATUS[b.status] || b.status}, ${b.phone})`).join("\n"));
    }
    open("schedule");
  });
  main.addEventListener("click", async (e) => {
    if (e.target.dataset.act !== "rm-ch") return;
    const id = e.target.closest("[data-ch]").dataset.ch;
    if (confirm("Remove this change? Those days go back to the hours under it.") && (await act(() => api(`/api/admin/schedule/${id}`, { method: "DELETE" }), "Removed"))) open("schedule");
  });
}

// ---------- announcements ----------
async function announce() {
  const [list, fams] = await Promise.all([api("/api/admin/announcements"), api("/api/admin/households")]);
  main.innerHTML = `
    <div class="card"><h2>Send an announcement</h2>
      <form id="ann">
        <label>Message (sent as a text) <textarea name="text" rows="3" required></textarea></label>
        <label>Recording for the calls (optional; without one the call reads the text in Yiddish) <input name="audio" type="file" accept="audio/*"></label>
        <label>To <select name="audience"><option value="all">Everyone</option>${fams.map((h) => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join("")}</select></label>
        <button>Send</button>
        <p class="quiet">Messages go out once the phone line is connected (stage 4). Until then they wait in the queue.</p>
      </form></div>
    <div class="card"><h2>Sent</h2>${list.length ? `<table><thead><tr><th>When</th><th>Message</th><th>Deliveries</th></tr></thead><tbody>${list.map((a) => `
      <tr><td>${esc(new Date(a.created_at).toLocaleString())}</td><td>${esc(a.text)}${a.recording ? '<div class="quiet">with recording</div>' : ""}</td>
      <td>${a.deliveries} · reached ${a.reached} · not reached ${a.not_reached}</td></tr>`).join("")}</tbody></table>` : '<p class="quiet">Nothing yet.</p>'}</div>`;
  $("#ann").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await act(async () => {
      let recording = null;
      const file = f.get("audio");
      if (file && file.size) {
        const res = await fetch("/api/admin/recordings", { method: "POST", headers: { "content-type": file.type || "audio/mpeg" }, body: file, credentials: "same-origin" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed");
        recording = data.recording;
      }
      const r = await api("/api/admin/announcements", { method: "POST", body: { text: f.get("text"), audience: f.get("audience"), recording } });
      toast(`Queued for ${r.phones} phones`);
      open("announce");
    });
  });
}

// ---------- feedback ----------
// Comments, complaints, suggestions and requests. Claude checks new ones regularly, does what is asked, and writes
// back here what it did or what it needs from you.
const FB_STATUS = { new: "New", working: "Claude is on it", needs_you: "Needs you", done: "Done", declined: "Not done" };
const FB_CLASS = { new: "pending", working: "accepted", needs_you: "proposed", done: "completed", declined: "rejected" };
async function feedback() {
  const list = await api("/api/admin/feedback");
  main.innerHTML = `
    <div class="card"><h2>Comments, complaints, suggestions, requests</h2>
      <form id="fb">
        <label>What kind <select name="kind"><option value="request">Request</option><option value="suggestion">Suggestion</option><option value="complaint">Complaint</option><option value="comment">Comment</option></select></label>
        <label>Write it here <textarea name="text" rows="4" required></textarea></label>
        <button>Send</button>
        <p class="quiet">Claude reads these regularly, does what is asked, and writes back below. If something is needed from you, it shows "Needs you".</p>
      </form></div>
    <div class="card"><h2>Sent</h2>${list.length ? `<div class="wrap"><table><thead><tr><th>When</th><th>From</th><th>What</th><th>Status</th><th></th></tr></thead><tbody>${list.map((f) => `
      <tr data-fb="${esc(f.id)}"><td>${esc(new Date(f.created_at).toLocaleString())}</td><td>${f.source === "driver" ? "Driver" : esc(f.author)}</td>
      <td><b>${esc(f.kind[0].toUpperCase() + f.kind.slice(1))}:</b> ${esc(f.text).replace(/\n/g, "<br>")}${f.reply ? `<div class="quiet">Answer: ${esc(f.reply).replace(/\n/g, "<br>")}</div>` : ""}</td>
      <td><span class="status ${FB_CLASS[f.status] || ""}">${esc(FB_STATUS[f.status] || f.status)}</span></td>
      <td class="actions">${["done", "declined"].includes(f.status) ? '<button class="ghost" data-act="fb-reopen">Reopen</button>' : '<button class="ghost" data-act="fb-close">Close</button>'}</td></tr>`).join("")}</tbody></table></div>` : '<p class="quiet">Nothing yet.</p>'}</div>`;
  $("#fb").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (await act(() => api("/api/admin/feedback", { method: "POST", body: { kind: f.get("kind"), text: f.get("text") } }), "Sent. Claude will look at it.")) open("feedback");
  });
  main.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    const id = b?.closest("[data-fb]")?.dataset.fb;
    if (!id) return;
    const status = b.dataset.act === "fb-close" ? "done" : "new";
    if (await act(() => api(`/api/admin/feedback/${id}`, { method: "PATCH", body: { status } }), status === "done" ? "Closed" : "Reopened")) open("feedback");
  });
}

// ---------- reports ----------
async function reports() {
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  main.innerHTML = `<div class="card"><form id="range" class="row"><label>From <input type="date" name="from" value="${day}"></label>
    <label>To <input type="date" name="to" value="${day}"></label><button>Show</button></form></div><div id="rep"></div>`;
  const show = async (from, to) => {
    const r = await api(`/api/admin/reports?from=${from}&to=${to}`);
    const stat = (label, v) => `<div class="stat"><b>${v ?? "—"}</b>${label}</div>`;
    $("#rep").innerHTML = `<div class="stats">
      ${stat("Rides requested", r.requested)}${stat("Accepted", r.accepted)}${stat("Rejected", r.rejected)}${stat("Completed", r.completed)}
      ${stat("Passengers transported", r.passengersTransported)}${stat("Cancelled", r.cancelled)}${stat("No-shows", r.noShows)}
      ${stat("Time changes", r.timeChanges)}${stat("Still pending", r.pending)}${stat("Average wait past window start (min)", r.averageWaitMinutes)}
      ${stat("Picked up on time", r.onTimePickups ? `${r.onTimePickups.onTime} of ${r.onTimePickups.of}` : null)}${stat("Average ride (min)", r.averageRideMinutes)}
      ${stat("Driving time (min)", r.drivingMinutes)}${stat("Miles", r.miles)}</div>
      <p class="quiet">Waiting and on-time come from the pickups the driver marks in the app; driving time and miles from the app's GPS.</p>
      <div class="card"><h2>Driver activity</h2>${Object.keys(r.driverActivity).length ? `<table><tbody>${Object.entries(r.driverActivity).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("")}</tbody></table>` : '<p class="quiet">None in this period.</p>'}</div>`;
  };
  $("#range").addEventListener("submit", (e) => { e.preventDefault(); const f = new FormData(e.target); act(() => show(f.get("from"), f.get("to"))); });
  await show(day, day);
}

// ---------- settings and admins ----------
async function settings() {
  const [s, admins, drivers] = await Promise.all([api("/api/admin/settings"), api("/api/admin/admins"), api("/api/admin/drivers")]);
  main.innerHTML = `
    <div class="card"><h2>Service</h2><form id="svc">
      <div class="row"><label>Opens <input type="time" name="open" value="${minuteToTime(s.openMinute)}"></label>
        <label>Closes <input type="time" name="close" value="${minuteToTime(s.closeMinute)}"></label>
        <label>Longest drive per trip (minutes) <input type="number" name="max" min="5" max="120" value="${s.maxTripMinutes}"></label>
        <label>Minutes at each stop <input type="number" name="stop" min="0" max="10" value="${s.stopMinutes}"></label></div>
      <label>Service areas (one per line) <textarea name="areas" rows="3">${esc(s.serviceAreas.join("\n"))}</textarea></label>
      <button>Save</button></form></div>
    <div class="card"><h2>Drivers</h2><table><tbody>${drivers.map((d) => `<tr data-driver="${esc(d.id)}"><td>${driverLine(d)}</td><td>${esc(d.phone)}</td>
        <td class="actions"><button class="ghost" data-act="pin">${d.has_pin ? "New PIN" : "Set PIN"}</button>
        <button class="ghost" data-act="drv-status" data-status="${d.status === "offline" ? "online" : "offline"}">Set ${d.status === "offline" ? "online" : "offline"}</button></td></tr>`).join("") || '<tr><td class="quiet">No driver yet.</td></tr>'}</tbody></table>
      <p class="quiet">The driver signs in to the app (Android, or <a href="/driver/" target="_blank">/driver/</a> in a phone's browser) with their phone number and PIN. A new PIN signs the old phone out.</p>
      <form id="drv" class="row"><label>Name <input name="name" required></label><label>Phone <input name="phone" required></label><button>Add driver</button></form></div>
    <div class="card"><h2>Admins</h2><table><tbody>${admins.map((a) => `<tr data-email="${esc(a.email)}"><td>${esc(a.email)}</td><td class="actions"><button class="danger" data-act="rm-admin">Remove</button></td></tr>`).join("")}</tbody></table>
      <form id="adm" class="row"><label>Email <input name="email" type="email" required></label><label>Temporary password (10+ characters) <input name="password" required minlength="10"></label><button>Add admin</button></form></div>
    <div class="card"><h2>Change my password</h2><form id="pw" class="row"><label>Current <input name="current" type="password" required></label>
      <label>New (10+ characters) <input name="password" type="password" required minlength="10"></label><button>Change</button></form></div>`;
  $("#svc").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    act(() => api("/api/admin/settings", { method: "PUT", body: {
      openMinute: timeToMinute(f.get("open")), closeMinute: timeToMinute(f.get("close")), maxTripMinutes: Number(f.get("max")), stopMinutes: Number(f.get("stop")),
      serviceAreas: f.get("areas").split("\n").map((x) => x.trim()).filter(Boolean),
    } }), "Saved");
  });
  $("#drv").addEventListener("submit", async (e) => { e.preventDefault(); if (await act(() => api("/api/admin/drivers", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }), "Driver added")) open("settings"); });
  $("#adm").addEventListener("submit", async (e) => { e.preventDefault(); if (await act(() => api("/api/admin/admins", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }), "Admin added")) open("settings"); });
  $("#pw").addEventListener("submit", async (e) => { e.preventDefault(); if (await act(() => api("/api/admin/password", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }), "Password changed")) e.target.reset(); });
  main.addEventListener("click", async (e) => {
    const driver = e.target.closest("[data-driver]")?.dataset.driver;
    if (e.target.dataset.act === "pin") {
      const pin = prompt("New PIN for the driver (4 to 8 digits). Tell it to the driver in person.");
      if (pin && (await act(() => api(`/api/admin/drivers/${driver}/pin`, { method: "POST", body: { pin } }), "PIN set"))) open("settings");
      return;
    }
    if (e.target.dataset.act === "drv-status") {
      if (await act(() => api(`/api/admin/drivers/${driver}/status`, { method: "POST", body: { status: e.target.dataset.status } }), "Saved")) open("settings");
      return;
    }
    if (e.target.dataset.act !== "rm-admin") return;
    const email = e.target.closest("[data-email]").dataset.email;
    if (confirm(`Remove ${email}?`) && (await act(() => api(`/api/admin/admins/${encodeURIComponent(email)}`, { method: "DELETE" }), "Removed"))) open("settings");
  });
}

async function activity() {
  const rows = await api("/api/admin/audit");
  main.innerHTML = `<div class="card"><h2>Activity</h2><div class="wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>${rows.map((r) => `
    <tr><td>${esc(new Date(r.at).toLocaleString())}</td><td>${esc(r.actor)}</td><td>${esc(r.action)}${r.booking_id ? `<div class="quiet">${esc(r.booking_id)}</div>` : ""}</td><td class="quiet">${esc(r.details)}</td></tr>`).join("")}</tbody></table></div></div>`;
}

start();
