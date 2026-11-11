// The server: admin sign-in, the admin API and the dashboard page. The Fonory hotline API (stage 4) and the driver app
// API (stage 5) are added here later.
import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDb, newId, nowIso, audit } from "./db.js";
import { changeStatus, proposeTime, getBooking } from "./bookings.js";
import { bookRide, previewAccept, acceptRide, refreshDay, dayRoute } from "./dispatch.js";
import { createTravel } from "./travel.js";
import { phoneStep } from "./phone/ivr.js";
import { webhookAllowed, fonoryClient } from "./phone/fonory.js";
import { yiddishVoice } from "./phone/yiddishtools.js";
import { makeWanted, wantAll } from "./phone/audio.js";
import { allPieces } from "./phone/words.js";
import { notifyBooking, queueReminders, sendDue, callEnded } from "./notify.js";
import * as auth from "./auth.js";
import { getSettings, updateSettings } from "./settings.js";
import { report } from "./reports.js";
import { createAnnouncement, listAnnouncements } from "./announcements.js";
import { localParts } from "./rules.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PHONE = /^\+1\d{10}$/;
const GENDERS = ["m", "f"];
const NOTIFY = ["text", "voice", "both"];

// "845-555-1234", "(845) 555 1234", "18455551234" → "+18455551234"; anything else → null.
export function normalizePhone(s) {
  const d = String(s || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

// deps.travel replaces Google Maps and deps.now the clock (tests).
export function createApp(db = openDb(), env = process.env, deps = {}) {
  auth.initAuth(db);
  const clock = deps.now || (() => new Date());
  const travel = deps.travel || createTravel(db, { apiKey: env.GOOGLE_MAPS_API_KEY, traffic: env.ROUTES_TRAFFIC !== "off", timeZone: getSettings(db).timeZone });
  auth.ensureFirstAdmin(db, env);
  const recordingsDir = env.RECORDINGS_DIR || path.join(path.dirname(env.DB_FILE || "data/dispatch.db"), "recordings");

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    next();
  });
  app.use(express.json({ limit: "200kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // --- the phone line (Fonory) ---
  const baseUrl = (req) => (env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  const notify = (b, kind, payload) => notifyBooking(db, b, kind, payload);
  const fonory = express.Router();
  fonory.use(express.urlencoded({ extended: false }));
  fonory.use((req, res, next) => (webhookAllowed(req, env) ? next() : res.status(403).json({ error: "forbidden" })));
  fonory.post("/step", async (req, res) => {
    try {
      res.json(await phoneStep({ db, travel, settings: getSettings(db), now: clock(), base: baseUrl(req), notify }, req.body || {}));
    } catch (e) {
      console.error("phone step failed:", e);
      res.json({ play: [{ prompt: "P03" }], hangup: true });
    }
  });
  fonory.post("/status", (req, res) => {
    const { call_id: callId, result } = req.body || {};
    if (!callId || !result) return res.status(400).json({ error: "call_id and result are needed" });
    res.json({ ok: true, outcome: callEnded(db, String(callId), String(result), clock()) });
  });
  app.use("/fonory", fonory);
  // Audio Fonory plays from us: saved pieces and uploaded recordings, under random names.
  app.get(["/audio/clips/:file", "/audio/:file"], (req, res) => {
    if (!/^[a-f0-9]{16,40}\.(wav|mp3|m4a|ogg|webm)$/.test(req.params.file)) return res.status(404).end();
    const dir = req.path.startsWith("/audio/clips/") ? path.join(recordingsDir, "clips") : recordingsDir;
    res.sendFile(path.join(dir, req.params.file), (err) => err && !res.headersSent && res.status(404).end());
  });
  app.get("/", (_req, res) => res.redirect("/admin/"));
  app.use("/admin", express.static(path.join(here, "..", "web")));

  // --- sign-in ---
  app.post("/api/login", (req, res) => {
    const email = auth.normEmail(req.body?.email);
    const key = `${req.ip}|${email}`;
    if (auth.tooManyTries(key)) return res.status(429).json({ error: "Too many tries. Wait 15 minutes." });
    const row = db.prepare("SELECT * FROM admins WHERE email = ?").get(email);
    if (!row || !auth.checkPassword(String(req.body?.password || ""), row.password_hash)) {
      auth.noteFailure(key);
      return res.status(401).json({ error: "Wrong email or password." });
    }
    const { token, expires } = auth.startSession(db, email);
    auth.setCookie(res, req, token, expires);
    audit(db, `admin:${email}`, "signed_in");
    res.json({ email });
  });
  app.post("/api/logout", (req, res) => {
    auth.endSession(db, req);
    auth.clearCookie(res);
    res.json({ ok: true });
  });

  const admin = express.Router();
  admin.use((req, res, next) => {
    const email = auth.sessionEmail(db, req);
    if (!email) return res.status(401).json({ error: "Please sign in." });
    req.admin = email;
    req.actor = `admin:${email}`;
    next();
  });
  const bad = (res, error) => res.status(400).json({ ok: false, error });

  admin.get("/me", (req, res) => res.json({ email: req.admin }));

  // --- admins ---
  admin.get("/admins", (_req, res) => res.json(db.prepare("SELECT email, created_at FROM admins ORDER BY created_at").all()));
  admin.post("/admins", (req, res) => {
    const r = auth.addAdmin(db, req.body.email, req.body.password, req.actor);
    r.ok ? res.json(r) : bad(res, r.error);
  });
  admin.delete("/admins/:email", (req, res) => {
    const email = auth.normEmail(req.params.email);
    if (email === req.admin) return bad(res, "You can't remove yourself.");
    db.prepare("DELETE FROM sessions WHERE email = ?").run(email);
    db.prepare("DELETE FROM admins WHERE email = ?").run(email);
    audit(db, req.actor, "admin_removed", null, { email });
    res.json({ ok: true });
  });
  admin.post("/password", (req, res) => {
    const row = db.prepare("SELECT * FROM admins WHERE email = ?").get(req.admin);
    if (!auth.checkPassword(String(req.body.current || ""), row.password_hash)) return bad(res, "The current password is wrong.");
    const problem = auth.passwordProblem(req.body.password);
    if (problem) return bad(res, problem);
    db.prepare("UPDATE admins SET password_hash = ? WHERE email = ?").run(auth.hashPassword(req.body.password), req.admin);
    audit(db, req.actor, "password_changed");
    res.json({ ok: true });
  });

  // --- families: households, passengers, phones ---
  admin.get("/households", (_req, res) => {
    const households = db.prepare("SELECT * FROM households WHERE active = 1 ORDER BY name").all();
    const passengers = db.prepare("SELECT * FROM passengers WHERE active = 1 ORDER BY name").all();
    const phones = db.prepare("SELECT * FROM phones WHERE active = 1").all();
    const places = db.prepare("SELECT * FROM places WHERE active = 1 ORDER BY code").all();
    res.json(households.map((h) => ({
      ...h,
      passengers: passengers.filter((p) => p.household_id === h.id),
      phones: phones.filter((p) => p.household_id === h.id),
      places: places.filter((p) => p.household_id === h.id),
    })));
  });
  admin.post("/households", (req, res) => {
    const name = String(req.body.name || "").trim();
    if (!name) return bad(res, "Give the family a name.");
    const id = newId("hh");
    db.prepare("INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)").run(id, name, nowIso());
    audit(db, req.actor, "household_added", null, { id, name });
    res.json({ ok: true, id });
  });
  admin.patch("/households/:id", (req, res) => {
    const name = String(req.body.name || "").trim();
    if (!name) return bad(res, "Give the family a name.");
    db.prepare("UPDATE households SET name = ? WHERE id = ?").run(name, req.params.id);
    audit(db, req.actor, "household_renamed", null, { id: req.params.id, name });
    res.json({ ok: true });
  });
  admin.delete("/households/:id", (req, res) => {
    const id = req.params.id;
    db.prepare("UPDATE households SET active = 0 WHERE id = ?").run(id);
    db.prepare("UPDATE phones SET active = 0 WHERE household_id = ?").run(id);
    db.prepare("UPDATE passengers SET active = 0 WHERE household_id = ?").run(id);
    audit(db, req.actor, "household_removed", null, { id });
    res.json({ ok: true });
  });

  admin.post("/passengers", (req, res) => {
    const { householdId, gender, notes = "" } = req.body;
    const name = String(req.body.name || "").trim();
    if (!name) return bad(res, "Give the passenger a name.");
    if (!GENDERS.includes(gender)) return bad(res, "Choose man or woman.");
    if (!db.prepare("SELECT 1 FROM households WHERE id = ? AND active = 1").get(householdId)) return bad(res, "Unknown family.");
    const id = newId("ps");
    const spoken = String(req.body.spoken || "").trim() || null;
    db.prepare("INSERT INTO passengers (id, household_id, name, gender, notes, spoken) VALUES (?, ?, ?, ?, ?, ?)").run(id, householdId, name, gender, notes, spoken);
    audit(db, req.actor, "passenger_added", null, { id, name });
    res.json({ ok: true, id });
  });
  admin.patch("/passengers/:id", (req, res) => {
    const p = db.prepare("SELECT * FROM passengers WHERE id = ?").get(req.params.id);
    if (!p) return res.status(404).json({ error: "not_found" });
    const name = req.body.name != null ? String(req.body.name).trim() : p.name;
    const gender = req.body.gender ?? p.gender;
    const notes = req.body.notes ?? p.notes;
    if (!name || !GENDERS.includes(gender)) return bad(res, "Name and man/woman are needed.");
    const spoken = req.body.spoken != null ? String(req.body.spoken).trim() || null : p.spoken;
    db.prepare("UPDATE passengers SET name = ?, gender = ?, notes = ?, spoken = ? WHERE id = ?").run(name, gender, notes, spoken, p.id);
    audit(db, req.actor, "passenger_changed", null, { id: p.id });
    res.json({ ok: true });
  });
  admin.delete("/passengers/:id", (req, res) => {
    db.prepare("UPDATE passengers SET active = 0 WHERE id = ?").run(req.params.id);
    audit(db, req.actor, "passenger_removed", null, { id: req.params.id });
    res.json({ ok: true });
  });

  admin.post("/phones", (req, res) => {
    const number = normalizePhone(req.body.number);
    const { householdId, passengerId = null, notify = "both" } = req.body;
    if (!number || !PHONE.test(number)) return bad(res, "Enter a 10-digit US phone number.");
    if (!NOTIFY.includes(notify)) return bad(res, "Choose text, voice or both.");
    if (!db.prepare("SELECT 1 FROM households WHERE id = ? AND active = 1").get(householdId)) return bad(res, "Unknown family.");
    const existing = db.prepare("SELECT * FROM phones WHERE number = ?").get(number);
    if (existing?.active) return bad(res, "That number is already approved.");
    if (existing) {
      db.prepare("UPDATE phones SET household_id = ?, passenger_id = ?, notify = ?, active = 1 WHERE number = ?").run(householdId, passengerId, notify, number);
    } else {
      db.prepare("INSERT INTO phones (number, household_id, passenger_id, notify) VALUES (?, ?, ?, ?)").run(number, householdId, passengerId, notify);
    }
    audit(db, req.actor, "phone_added", null, { number });
    res.json({ ok: true, number });
  });
  admin.patch("/phones/:number", (req, res) => {
    const notify = req.body.notify;
    if (!NOTIFY.includes(notify)) return bad(res, "Choose text, voice or both.");
    db.prepare("UPDATE phones SET notify = ? WHERE number = ?").run(notify, req.params.number);
    audit(db, req.actor, "phone_changed", null, { number: req.params.number, notify });
    res.json({ ok: true });
  });
  admin.delete("/phones/:number", (req, res) => {
    db.prepare("UPDATE phones SET active = 0 WHERE number = ?").run(req.params.number);
    audit(db, req.actor, "phone_removed", null, { number: req.params.number });
    res.json({ ok: true });
  });

  // --- places (saved addresses, picked by a 2-digit code on the phone) ---
  admin.get("/places", (_req, res) => res.json(db.prepare("SELECT * FROM places WHERE active = 1 ORDER BY household_id IS NOT NULL, code").all()));
  admin.post("/places", (req, res) => {
    const { householdId = null, kind = "other" } = req.body;
    const code = String(req.body.code || "").trim();
    const name = String(req.body.name || "").trim();
    const address = String(req.body.address || "").trim();
    if (!/^\d{2}$/.test(code)) return bad(res, "The code must be 2 digits.");
    if (!name || !address) return bad(res, "Name and address are needed.");
    if (!["home", "work", "other"].includes(kind)) return bad(res, "Kind must be home, work or other.");
    // A household sees its own codes and the shared ones, so a code may not repeat across those.
    const taken = db.prepare("SELECT 1 FROM places WHERE active = 1 AND code = ? AND (household_id IS NULL OR ? IS NULL OR household_id = ?)").get(code, householdId, householdId);
    if (taken) return bad(res, `Code ${code} is already used.`);
    const id = newId("pl");
    const spoken = String(req.body.spoken || "").trim() || null;
    db.prepare("INSERT INTO places (id, household_id, code, kind, name, address, spoken) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, householdId, code, kind, name, address, spoken);
    audit(db, req.actor, "place_added", null, { id, code, name });
    res.json({ ok: true, id });
  });
  admin.patch("/places/:id", (req, res) => {
    const p = db.prepare("SELECT * FROM places WHERE id = ?").get(req.params.id);
    if (!p) return res.status(404).json({ error: "not_found" });
    const name = String(req.body.name ?? p.name).trim();
    const address = String(req.body.address ?? p.address).trim();
    if (!name || !address) return bad(res, "Name and address are needed.");
    if (req.body.spoken != null) db.prepare("UPDATE places SET spoken = ? WHERE id = ?").run(String(req.body.spoken).trim() || null, p.id);
    db.prepare("UPDATE places SET name = ?, address = ?, lat = CASE WHEN ? = address THEN lat END, lng = CASE WHEN ? = address THEN lng END WHERE id = ?")
      .run(name, address, address, address, p.id);
    audit(db, req.actor, "place_changed", null, { id: p.id });
    res.json({ ok: true });
  });
  admin.delete("/places/:id", (req, res) => {
    db.prepare("UPDATE places SET active = 0 WHERE id = ?").run(req.params.id);
    audit(db, req.actor, "place_removed", null, { id: req.params.id });
    res.json({ ok: true });
  });

  // --- drivers ---
  admin.get("/drivers", (_req, res) => res.json(db.prepare("SELECT * FROM drivers ORDER BY name").all()));
  admin.post("/drivers", (req, res) => {
    const name = String(req.body.name || "").trim();
    const phone = normalizePhone(req.body.phone);
    if (!name || !phone) return bad(res, "Name and a 10-digit phone number are needed.");
    const id = newId("drv");
    db.prepare("INSERT INTO drivers (id, name, phone) VALUES (?, ?, ?)").run(id, name, phone);
    audit(db, req.actor, "driver_added", null, { id });
    res.json({ ok: true, id });
  });

  // --- bookings ---
  admin.get("/bookings", (req, res) => {
    const day = req.query.day || localParts(clock(), getSettings(db).timeZone).day;
    const status = req.query.status;
    const rows = status
      ? db.prepare("SELECT * FROM bookings WHERE status = ? ORDER BY day DESC, pickup_minute LIMIT 500").all(status)
      : db.prepare("SELECT * FROM bookings WHERE day = ? ORDER BY pickup_minute").all(day);
    res.json(rows);
  });
  admin.post("/bookings", async (req, res) => {
    const r = await bookRide(db, travel, { ...req.body, phone: normalizePhone(req.body.phone) }, clock(), getSettings(db), req.actor);
    if (r.ok) for (const b of r.bookings) notify(b, "booked");
    res.status(r.ok ? 200 : 400).json(r);
  });
  admin.get("/route", (req, res) => {
    const day = req.query.day || localParts(clock(), getSettings(db).timeZone).day;
    res.json(dayRoute(db, day));
  });
  admin.post("/route/refresh", async (req, res) => {
    const day = req.body.day || localParts(clock(), getSettings(db).timeZone).day;
    const r = await refreshDay(db, travel, day, getSettings(db), clock());
    res.json({ ...r, route: dayRoute(db, day) });
  });
  admin.get("/bookings/:id/preview", async (req, res) => {
    const r = await previewAccept(db, travel, req.params.id, getSettings(db), clock());
    res.status(r.ok ? 200 : 400).json(r);
  });
  admin.patch("/bookings/:id", async (req, res) => {
    const b = getBooking(db, req.params.id);
    if (!b) return res.status(404).json({ error: "not_found" });
    if (!["pending", "proposed", "accepted"].includes(b.status)) return bad(res, "This ride can no longer be changed.");
    const pickup = String(req.body.pickup_address ?? b.pickup_address).trim();
    const dropoff = String(req.body.dropoff_address ?? b.dropoff_address).trim();
    if (!pickup || !dropoff) return bad(res, "Pickup and destination are needed.");
    // A changed address needs a new map point (found again on the refresh).
    db.prepare(`UPDATE bookings SET pickup_address = ?, dropoff_address = ?, updated_at = ?,
      pickup_lat = CASE WHEN pickup_address = ? THEN pickup_lat END, pickup_lng = CASE WHEN pickup_address = ? THEN pickup_lng END,
      dropoff_lat = CASE WHEN dropoff_address = ? THEN dropoff_lat END, dropoff_lng = CASE WHEN dropoff_address = ? THEN dropoff_lng END
      WHERE id = ?`).run(pickup, dropoff, nowIso(), pickup, pickup, dropoff, dropoff, b.id);
    audit(db, req.actor, "booking_changed", b.id, { pickup_address: pickup, dropoff_address: dropoff });
    const r = b.status === "accepted" ? await refreshDay(db, travel, b.day, getSettings(db), clock()) : null;
    const late = r?.route && (r.route.late[b.id] || Object.keys(r.route.late).length || Object.keys(r.route.over).length);
    res.json({ ok: true, booking: getBooking(db, b.id), warning: late ? "With the new address some pickups can't be on time. Check today's route." : null });
  });
  admin.post("/bookings/:id/:action", async (req, res) => {
    const { id, action } = req.params;
    const driverId = req.body.driverId || db.prepare("SELECT id FROM drivers ORDER BY rowid LIMIT 1").get()?.id;
    if (["accept", "propose"].includes(action) && !driverId) return bad(res, "Add a driver first.");
    let r;
    const settings = getSettings(db);
    if (action === "accept") {
      r = await acceptRide(db, travel, id, driverId, settings, clock());
      if (r.ok) notify(r.booking, "accepted");
    } else if (action === "propose") {
      const was = getBooking(db, id);
      r = proposeTime(db, id, req.body.minute, driverId);
      if (r.ok) notify(r.booking, "time_change", { oldMinute: was.pickup_minute, newMinute: r.booking.proposed_minute });
    }
    else if (["reject", "cancel", "pickup", "done", "no_show"].includes(action)) {
      const was = getBooking(db, id);
      r = changeStatus(db, id, action, req.actor, clock(), settings);
      if (r.ok && ["accepted", "picked_up"].includes(was.status)) await refreshDay(db, travel, was.day, settings, clock());
      if (r.ok && action === "reject") notify(r.booking, "not_taken");
      if (r.ok && action === "cancel" && !req.actor.startsWith("phone:")) notify(r.booking, "cancelled");
    } else return res.status(404).json({ error: "unknown_action" });
    res.status(r.ok ? 200 : 400).json(r);
  });
  admin.get("/bookings/:id", (req, res) => {
    const b = getBooking(db, req.params.id);
    b ? res.json(b) : res.status(404).json({ error: "not_found" });
  });

  // --- settings, reports, activity ---
  admin.get("/settings", (_req, res) => res.json(getSettings(db)));
  admin.put("/settings", (req, res) => {
    const r = updateSettings(db, req.body, req.actor);
    r.ok ? res.json(r) : bad(res, r.error);
  });
  admin.get("/reports", (req, res) => {
    const today = localParts(clock(), getSettings(db).timeZone).day;
    res.json(report(db, req.query.from || today, req.query.to || today));
  });
  admin.get("/audit", (_req, res) => res.json(db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 500").all()));

  // --- announcements and recordings ---
  admin.get("/announcements", (_req, res) => res.json(listAnnouncements(db)));
  admin.post("/announcements", (req, res) => {
    const r = createAnnouncement(db, req.body, req.actor);
    r.ok ? res.json(r) : bad(res, r.error);
  });
  admin.post("/recordings", express.raw({ type: "audio/*", limit: "5mb" }), (req, res) => {
    const ext = { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a" }[req.get("content-type")];
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return bad(res, "Upload an mp3, wav, webm, ogg or m4a file.");
    fs.mkdirSync(recordingsDir, { recursive: true });
    const name = `${crypto.randomBytes(12).toString("hex")}.${ext}`;
    fs.writeFileSync(path.join(recordingsDir, name), req.body);
    audit(db, req.actor, "recording_uploaded", null, { name });
    res.json({ ok: true, recording: name });
  });

  app.use("/api/admin", admin);
  return app;
}

// Background work every 20 seconds: reminders, sending what's due through Fonory, recording spoken pieces.
export function startLoops(db, env = process.env) {
  const client = fonoryClient(env);
  const speak = yiddishVoice(env);
  const dir = env.RECORDINGS_DIR || path.join(path.dirname(env.DB_FILE || "data/dispatch.db"), "recordings");
  if (speak) {
    wantAll(db, allPieces());
    const names = db.prepare("SELECT coalesce(spoken, name) AS t FROM passengers WHERE active = 1 AND recording IS NULL UNION SELECT coalesce(spoken, name) FROM places WHERE active = 1 AND recording IS NULL").all();
    wantAll(db, names.map((r) => r.t));
  }
  if (!client) console.log("Fonory isn't connected yet (FONORY_API_URL, FONORY_API_KEY): messages wait in the queue.");
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      queueReminders(db, getSettings(db));
      await sendDue(db, client);
      if (speak) await makeWanted(db, dir, speak, { limit: 10 });
    } catch (e) {
      console.error("background work failed:", e);
    } finally {
      busy = false;
    }
  };
  return setInterval(tick, 20000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 3000;
  const db = openDb();
  createApp(db).listen(port, () => console.log(`dispatch listening on ${port}`));
  startLoops(db);
}
