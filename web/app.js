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
  if (!res.ok) throw new Error(data.error || (data.errors || []).map(errorText).join(", ") || `Error ${res.status}`);
  return data;
}

const ERRORS = {
  not_registered: "That phone number isn't approved", not_today: "Only same-day rides", outside_hours: "Outside service hours",
  in_past: "That time already passed", bad_window: "Choose a 15 or 30 minute window", no_seats: "No fitting seats at that time",
  no_riders: "Enter how many men and women", no_pickup: "Choose a pickup place", no_dropoff: "Choose a destination",
  return_before_pickup: "The return must be after the pickup", return_outside_hours: "The return is outside service hours",
  wrong_status: "Not possible in this ride's status", not_pending: "This ride isn't waiting for an answer",
};
const errorText = (c) => ERRORS[c] || c;

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3000);
}
async function act(fn, ok) {
  try { await fn(); if (ok) toast(ok); return true; } catch (e) { if (e.message !== "signed out") toast(e.message); return false; }
}

const minuteText = (m) => {
  if (m == null) return "";
  const h24 = Math.floor(m / 60);
  return `${((h24 + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
};
const timeToMinute = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
const minuteToTime = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const STATUS = { pending: "Waiting for driver", proposed: "New time offered", accepted: "Accepted", picked_up: "On board", completed: "Completed", rejected: "Rejected", cancelled: "Cancelled", no_show: "No-show" };
const riders = (b) => [b.men && `${b.men} men`, b.women && `${b.women} women`].filter(Boolean).join(", ") + (b.together ? " (may sit together)" : "");

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
const TABS = { today, pending, families, places, announce, reports, settings, activity };
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
      <td>${esc(b.rider_name || "")}<div class="quiet">${esc(riders(b))}<br>${esc(b.booked_by_phone)}</div></td>
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
      if (await act(() => api(`/api/admin/bookings/${id}`, { method: "PATCH", body: { pickup_address: pickup, dropoff_address: dropoff } }), "Changed")) reload();
      return;
    }
    let body = {};
    if (a === "propose") {
      const t = prompt("New pickup time (for example 14:30)");
      if (!t) return;
      body = { minute: timeToMinute(t) };
    }
    if (["cancel", "reject", "no_show"].includes(a) && !confirm("Are you sure?")) return;
    if (await act(() => api(`/api/admin/bookings/${id}/${a}`, { method: "POST", body }), "Done")) reload();
  });
}

async function today() {
  const [rows, fams] = await Promise.all([api("/api/admin/bookings"), api("/api/admin/households")]);
  const phones = fams.flatMap((h) => h.phones.map((p) => ({ ...p, family: h.name, places: h.places })));
  const shared = await api("/api/admin/places");
  main.innerHTML = `
    <div class="card"><h2>Today's rides</h2><div id="list">${bookingTable(rows)}</div></div>
    <div class="card"><h2>Book a ride for a caller</h2>
      <form id="book">
        <div class="row">
          <label>Caller's phone <select name="phone" required>${phones.map((p) => `<option value="${esc(p.number)}">${esc(p.family)}: ${esc(p.number)}</option>`).join("")}</select></label>
          <label>Rider's name <input name="riderName"></label>
        </div>
        <div class="row">
          <label>Men <input name="men" type="number" min="0" max="7" value="0"></label>
          <label>Women <input name="women" type="number" min="0" max="6" value="0"></label>
          <label><input name="together" type="checkbox"> Men and women may sit together</label>
        </div>
        <div class="row">
          <label>From <select name="from">${placeOptions(shared)}</select></label>
          <label>To <select name="to">${placeOptions(shared)}</select></label>
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
  $("#book").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {
      phone: f.get("phone"), riderName: f.get("riderName"), men: Number(f.get("men")), women: Number(f.get("women")),
      together: !!f.get("together"), pickup: { placeId: f.get("from") }, dropoff: { placeId: f.get("to") },
      pickupMinute: f.get("time") ? timeToMinute(f.get("time")) : null, window: Number(f.get("window")),
      returnMinute: f.get("ret") ? timeToMinute(f.get("ret")) : undefined,
    };
    if (await act(() => api("/api/admin/bookings", { method: "POST", body }), "Ride requested; it waits for the driver")) reload();
  });
}
const placeOptions = (places) => places.map((p) => `<option value="${esc(p.id)}">${esc(p.code)} ${esc(p.name)}${p.household_id ? "" : " (shared)"}</option>`).join("");

async function pending() {
  const rows = [...(await api("/api/admin/bookings?status=pending")), ...(await api("/api/admin/bookings?status=proposed"))];
  main.innerHTML = `<div class="card"><h2>Waiting for the driver</h2><div id="list">${bookingTable(rows, { showDay: true })}</div></div>`;
  wireBookings($("#list"), () => open("pending"));
}

// ---------- families ----------
async function families() {
  const fams = await api("/api/admin/households");
  main.innerHTML = `
    <div class="card"><h2>Add a family</h2><form id="add-fam" class="row"><label>Family name <input name="name" required></label><button>Add</button></form></div>
    ${fams.map((h) => `
      <div class="card" data-hh="${esc(h.id)}">
        <div class="row" style="justify-content:space-between"><h2>${esc(h.name)}</h2>
          <span><button class="ghost" data-act="rename">Rename</button> <button class="danger" data-act="remove-fam">Remove family</button></span></div>
        <h3>People</h3>
        <table><tbody>${h.passengers.map((p) => `<tr data-ps="${esc(p.id)}"><td>${esc(p.name)}</td><td>${p.gender === "m" ? "Man" : "Woman"}</td><td class="quiet">${esc(p.notes)}</td>
          <td class="actions"><button class="ghost" data-act="edit-ps">Edit</button><button class="danger" data-act="remove-ps">Remove</button></td></tr>`).join("") || '<tr><td class="quiet">No one yet.</td></tr>'}</tbody></table>
        <form class="row" data-form="ps"><label>Name <input name="name" required></label>
          <label>Man or woman <select name="gender"><option value="m">Man</option><option value="f">Woman</option></select></label>
          <label>Notes for the driver <input name="notes"></label><button>Add person</button></form>
        <h3>Approved phones</h3>
        <table><tbody>${h.phones.map((p) => `<tr data-ph="${esc(p.number)}"><td>${esc(p.number)}</td>
          <td><select data-act="notify">${["both", "text", "voice"].map((n) => `<option value="${n}" ${p.notify === n ? "selected" : ""}>${n === "both" ? "Texts and calls" : n === "text" ? "Texts only" : "Calls only"}</option>`).join("")}</select></td>
          <td class="actions"><button class="danger" data-act="remove-ph">Remove</button></td></tr>`).join("") || '<tr><td class="quiet">No phones yet.</td></tr>'}</tbody></table>
        <form class="row" data-form="ph"><label>Phone number <input name="number" required placeholder="845-555-1234"></label>
          <label>Messages by <select name="notify"><option value="both">Texts and calls</option><option value="text">Texts only</option><option value="voice">Calls only</option></select></label><button>Add phone</button></form>
        <h3>Saved places</h3>
        <table><tbody>${h.places.map((p) => placeRow(p)).join("") || '<tr><td class="quiet">No places yet.</td></tr>'}</tbody></table>
        <form class="row" data-form="pl"><label>Code <input name="code" required pattern="\\d{2}" maxlength="2" placeholder="01"></label>
          <label>Kind <select name="kind"><option value="home">Home</option><option value="work">Work</option><option value="other">Other</option></select></label>
          <label>Name <input name="name" required></label><label>Address <input name="address" required></label><button>Add place</button></form>
      </div>`).join("")}`;

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
    const path = { ps: "passengers", ph: "phones", pl: "places" }[kind];
    if (await act(() => api(`/api/admin/${path}`, { method: "POST", body: { ...f, householdId: hh } }), "Added")) open("families");
  });
  main.addEventListener("change", async (e) => {
    if (e.target.dataset.act !== "notify") return;
    const number = e.target.closest("[data-ph]").dataset.ph;
    await act(() => api(`/api/admin/phones/${encodeURIComponent(number)}`, { method: "PATCH", body: { notify: e.target.value } }), "Saved");
  });
  main.addEventListener("click", async (e) => {
    const a = e.target.dataset.act;
    if (!a || a === "notify") return;
    const hh = e.target.closest("[data-hh]")?.dataset.hh;
    const ps = e.target.closest("[data-ps]")?.dataset.ps;
    const ph = e.target.closest("[data-ph]")?.dataset.ph;
    const pl = e.target.closest("[data-pl]")?.dataset.pl;
    let done = false;
    if (a === "rename") { const n = prompt("New family name"); if (n) done = await act(() => api(`/api/admin/households/${hh}`, { method: "PATCH", body: { name: n } })); }
    if (a === "remove-fam" && confirm("Remove this family and all its phones?")) done = await act(() => api(`/api/admin/households/${hh}`, { method: "DELETE" }));
    if (a === "edit-ps") { const notes = prompt("Notes for the driver"); if (notes != null) done = await act(() => api(`/api/admin/passengers/${ps}`, { method: "PATCH", body: { notes } })); }
    if (a === "remove-ps" && confirm("Remove this person?")) done = await act(() => api(`/api/admin/passengers/${ps}`, { method: "DELETE" }));
    if (a === "remove-ph" && confirm("Remove this phone? It won't be able to book.")) done = await act(() => api(`/api/admin/phones/${encodeURIComponent(ph)}`, { method: "DELETE" }));
    if (a === "edit-pl") done = await editPlace(pl);
    if (a === "remove-pl" && confirm("Remove this place?")) done = await act(() => api(`/api/admin/places/${pl}`, { method: "DELETE" }));
    if (done) open(current);
  });
}
const placeRow = (p) => `<tr data-pl="${esc(p.id)}"><td>${esc(p.code)}</td><td>${esc(p.name)}</td><td>${esc(p.address)}</td>
  <td class="actions"><button class="ghost" data-act="edit-pl">Edit</button><button class="danger" data-act="remove-pl">Remove</button></td></tr>`;
async function editPlace(id) {
  const address = prompt("New address");
  if (!address) return false;
  return act(() => api(`/api/admin/places/${id}`, { method: "PATCH", body: { address } }), "Saved");
}

// ---------- shared places ----------
async function places() {
  const all = (await api("/api/admin/places")).filter((p) => !p.household_id);
  main.innerHTML = `<div class="card"><h2>Shared places</h2><p class="quiet">Places every family can use, like shuls and stores. Family homes are under Families.</p>
    <table><tbody>${all.map(placeRow).join("") || '<tr><td class="quiet">None yet.</td></tr>'}</tbody></table>
    <form class="row" id="add-pl"><label>Code <input name="code" required pattern="\\d{2}" maxlength="2"></label>
      <label>Name <input name="name" required></label><label>Address <input name="address" required></label><button>Add place</button></form></div>`;
  $("#add-pl").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (await act(() => api("/api/admin/places", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }), "Added")) open("places");
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

// ---------- announcements ----------
async function announce() {
  const [list, fams] = await Promise.all([api("/api/admin/announcements"), api("/api/admin/households")]);
  main.innerHTML = `
    <div class="card"><h2>Send an announcement</h2>
      <form id="ann">
        <label>Message (sent as a text) <textarea name="text" rows="3" required></textarea></label>
        <label>Recording for phones set to calls (mp3, wav, m4a) <input name="audio" type="file" accept="audio/*"></label>
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
      toast(`Queued for ${r.phones} phones${r.voiceSkipped ? `; ${r.voiceSkipped} call-only phones need a recording` : ""}`);
      open("announce");
    });
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
      ${stat("Time changes", r.timeChanges)}${stat("Still pending", r.pending)}${stat("Average wait (min)", r.averageWaitMinutes)}
      ${stat("Driving time (min)", r.drivingMinutes)}${stat("Miles", r.miles)}</div>
      <p class="quiet">Wait time, driving time and miles start once the driver app is in use.</p>
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
        <label>Longest drive per trip (minutes) <input type="number" name="max" min="5" max="120" value="${s.maxTripMinutes}"></label></div>
      <label>Service areas (one per line) <textarea name="areas" rows="3">${esc(s.serviceAreas.join("\n"))}</textarea></label>
      <button>Save</button></form></div>
    <div class="card"><h2>Drivers</h2><table><tbody>${drivers.map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(d.phone)}</td><td>${esc(d.status)}</td></tr>`).join("") || '<tr><td class="quiet">No driver yet.</td></tr>'}</tbody></table>
      <form id="drv" class="row"><label>Name <input name="name" required></label><label>Phone <input name="phone" required></label><button>Add driver</button></form></div>
    <div class="card"><h2>Admins</h2><table><tbody>${admins.map((a) => `<tr data-email="${esc(a.email)}"><td>${esc(a.email)}</td><td class="actions"><button class="danger" data-act="rm-admin">Remove</button></td></tr>`).join("")}</tbody></table>
      <form id="adm" class="row"><label>Email <input name="email" type="email" required></label><label>Temporary password (10+ characters) <input name="password" required minlength="10"></label><button>Add admin</button></form></div>
    <div class="card"><h2>Change my password</h2><form id="pw" class="row"><label>Current <input name="current" type="password" required></label>
      <label>New (10+ characters) <input name="password" type="password" required minlength="10"></label><button>Change</button></form></div>`;
  $("#svc").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    act(() => api("/api/admin/settings", { method: "PUT", body: {
      openMinute: timeToMinute(f.get("open")), closeMinute: timeToMinute(f.get("close")), maxTripMinutes: Number(f.get("max")),
      serviceAreas: f.get("areas").split("\n").map((x) => x.trim()).filter(Boolean),
    } }), "Saved");
  });
  $("#drv").addEventListener("submit", async (e) => { e.preventDefault(); if (await act(() => api("/api/admin/drivers", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }), "Driver added")) open("settings"); });
  $("#adm").addEventListener("submit", async (e) => { e.preventDefault(); if (await act(() => api("/api/admin/admins", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }), "Admin added")) open("settings"); });
  $("#pw").addEventListener("submit", async (e) => { e.preventDefault(); if (await act(() => api("/api/admin/password", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }), "Password changed")) e.target.reset(); });
  main.addEventListener("click", async (e) => {
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
