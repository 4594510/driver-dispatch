// The server: admin sign-in, the admin API and the dashboard page (/admin/), the Fonory hotline API (/fonory), and the
// driver app (/driver/) with its API (/api/driver).
import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDb, newId, nowIso, audit } from "./db.js";
import { getBooking } from "./bookings.js";
import { bookRide, previewAccept, refreshDay, dayRoute } from "./dispatch.js";
import { createTravel, AREA_KM } from "./travel.js";
import { phoneStep } from "./phone/ivr.js";
import { webhookAllowed, fromTeltech, fonoryClient, readStep, toActions } from "./phone/fonory.js";
import { yiddishVoice } from "./phone/yiddishtools.js";
import { makeWanted, wantAll } from "./phone/audio.js";
import { allPieces } from "./phone/words.js";
import { notifyBooking, queueReminders, sendDue, callEnded } from "./notify.js";
import * as auth from "./auth.js";
import { getSettings, updateSettings } from "./settings.js";
import { scheduleView, addChange, removeChange } from "./schedule.js";
import { report } from "./reports.js";
import { createAnnouncement, listAnnouncements } from "./announcements.js";
import { localParts, normalCode } from "./rules.js";
import { rideAction, runningLate, ADMIN_ACTIONS } from "./actions.js";
import { driverRouter, setPin, driverNow } from "./driver.js";
import { backupNow, backupDue } from "./backup.js";
import { priorityOf, listPriorities, addPriority, removePriority } from "./priority.js";
import { addFeedback, listFeedback, updateFeedback, feedbackRouter } from "./feedback.js";
import { listRelations, setRelation, removeRelation, peopleForFamily, KINDS, SEATING } from "./relations.js";

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
  fonory.use((req, res, next) => {
    if (webhookAllowed(req, env)) return next();
    const why = !fromTeltech(req, env) ? "not Teltech's address" : req.get("x-fonory-key") || req.query.key ? "wrong key" : "no key";
    console.log(`phone line: refused ${req.method} ${req.path} from ${req.ip} (${why})`);
    res.status(403).json({ error: "forbidden" });
  });
  fonory.post("/step", async (req, res) => {
    try {
      const base = baseUrl(req);
      res.json(toActions(await phoneStep({ db, travel, settings: getSettings(db, clock()), now: clock(), base, notify }, readStep(req)), base, env));
    } catch (e) {
      console.error("phone step failed:", e);
      res.json(toActions({ play: [{ prompt: "P03" }], hangup: true }, baseUrl(req), env));
    }
  });
  fonory.post("/status", (req, res) => {
    const { call_id: callId } = req.body || {};
    const result = req.body?.result || req.body?.status;
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
  // The fixed prompts (P01 …), 8 kHz WAV, for Fonory to fetch by link.
  app.use("/prompts", express.static(path.join(here, "..", "prompts"), { maxAge: "1h" }));
  app.get("/", (_req, res) => res.redirect("/admin/"));
  app.use("/driver", express.static(path.join(here, "..", "web", "driver"), { setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") }));
  app.use("/admin", express.static(path.join(here, "..", "web")));

  // --- the driver app ---
  const rideCtx = () => ({ db, travel, settings: getSettings(db, clock()), now: clock(), notify });
  app.use("/api/driver", driverRouter(db, rideCtx));
  // Claude's reading of feedback, with FEEDBACK_KEY (feedback.js).
  app.use("/api/feedback", feedbackRouter(db, env));

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
    const places = db.prepare("SELECT * FROM places WHERE active = 1 ORDER BY length(code), code").all();
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
    // Their phone stays approved and goes back to the whole family.
    db.prepare("UPDATE phones SET passenger_id = NULL WHERE passenger_id = ?").run(req.params.id);
    audit(db, req.actor, "passenger_removed", null, { id: req.params.id });
    res.json({ ok: true });
  });

  admin.post("/phones", (req, res) => {
    const number = normalizePhone(req.body.number);
    const { householdId, notify = "both" } = req.body;
    const passengerId = req.body.passengerId || null;
    if (!number || !PHONE.test(number)) return bad(res, "Enter a 10-digit US phone number.");
    if (!NOTIFY.includes(notify)) return bad(res, "Choose text, voice or both.");
    if (!db.prepare("SELECT 1 FROM households WHERE id = ? AND active = 1").get(householdId)) return bad(res, "Unknown family.");
    if (passengerId && !personOf(householdId, passengerId)) return bad(res, "That person isn't in this family.");
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
  // A phone belongs to a whole family, or to one person in it (then "for myself" on the phone means that person).
  const personOf = (householdId, passengerId) => db.prepare("SELECT 1 FROM passengers WHERE id = ? AND household_id = ? AND active = 1").get(passengerId, householdId);
  admin.patch("/phones/:number", (req, res) => {
    const phone = db.prepare("SELECT * FROM phones WHERE number = ? AND active = 1").get(req.params.number);
    if (!phone) return bad(res, "Unknown phone.");
    const notify = req.body.notify ?? phone.notify;
    if (!NOTIFY.includes(notify)) return bad(res, "Choose text, voice or both.");
    const passengerId = req.body.passengerId !== undefined ? req.body.passengerId || null : phone.passenger_id;
    if (passengerId && !personOf(phone.household_id, passengerId)) return bad(res, "That person isn't in this family.");
    db.prepare("UPDATE phones SET notify = ?, passenger_id = ? WHERE number = ?").run(notify, passengerId, phone.number);
    audit(db, req.actor, "phone_changed", null, { number: phone.number, notify, passengerId });
    res.json({ ok: true });
  });
  admin.delete("/phones/:number", (req, res) => {
    db.prepare("UPDATE phones SET active = 0 WHERE number = ?").run(req.params.number);
    audit(db, req.actor, "phone_removed", null, { number: req.params.number });
    res.json({ ok: true });
  });

  // --- priority levels (a family or one person, always or for a time range) ---
  admin.get("/priorities", (_req, res) => res.json(listPriorities(db)));
  admin.post("/priorities", (req, res) => {
    const r = addPriority(db, req.body, req.actor);
    r.ok ? res.json(r) : bad(res, r.error);
  });
  admin.delete("/priorities/:id", (req, res) => {
    const r = removePriority(db, req.params.id, req.actor);
    r.ok ? res.json(r) : bad(res, r.error);
  });

  // --- relations between people, and who may or may not sit next to whom ---
  admin.get("/relations", (_req, res) => res.json({ relations: listRelations(db), kinds: KINDS, seating: SEATING }));
  admin.post("/relations", (req, res) => {
    const r = setRelation(db, req.body, req.actor);
    r.ok ? res.json(r) : bad(res, r.error);
  });
  admin.delete("/relations/:id", (req, res) => {
    const r = removeRelation(db, req.params.id, req.actor);
    r.ok ? res.json(r) : bad(res, r.error);
  });
  // Who a phone may name on a ride: its family and their relatives (the dashboard's booking form).
  admin.get("/phones/:number/people", (req, res) => {
    const phone = db.prepare("SELECT * FROM phones WHERE number = ? AND active = 1").get(normalizePhone(req.params.number));
    if (!phone) return bad(res, "Unknown phone.");
    res.json(peopleForFamily(db, phone.household_id).map((p) => ({ id: p.id, name: p.name, gender: p.gender, household_id: p.household_id })));
  });

  // --- places (saved addresses, picked by a 1-3 digit code on the phone) ---
  admin.get("/places", (_req, res) => res.json(db.prepare("SELECT * FROM places WHERE active = 1 ORDER BY household_id IS NOT NULL, length(code), code").all()));
  // Codes a family sees: its own and the shared ones (a shared place sees every code).
  const usedCodes = (householdId, exceptId = null) => new Map(db
    .prepare("SELECT code, name FROM places WHERE active = 1 AND id IS NOT ? AND (household_id IS NULL OR ? IS NULL OR household_id = ?)")
    .all(exceptId, householdId, householdId).map((p) => [p.code, p.name]));
  const freeCode = (used) => { for (let i = 1; i < 1000; i++) { const c = String(i).padStart(2, "0"); if (!used.has(c)) return c; } return null; };
  // Check an address with Google before saving it, so a typo shows now and not when a ride is booked.
  const checkAddress = async (address) => {
    const r = travel.lookup ? await travel.lookup(address) : { status: "unknown" };
    if (r.status === "not_found") return { error: `Google Maps can't find "${address}". Check the spelling and add the town, for example: 12 Main St, Monsey NY.` };
    if (r.status !== "found") return { point: null };
    const km = r.km ?? 0;
    const warning = km > AREA_KM ? `Google found ${r.formatted}, about ${Math.round(km / 1.6)} miles from Monsey. Check that this is right.`
      : !r.exact ? `Google only found ${r.formatted}. Add the house number so the driver finds the right door.` : null;
    return { point: { lat: r.lat, lng: r.lng }, found: r.formatted, warning };
  };
  admin.post("/places", async (req, res) => {
    const householdId = req.body.householdId || null;
    const kind = req.body.kind || "other";
    let code = String(req.body.code ?? "").trim();
    const name = String(req.body.name || "").trim();
    const address = String(req.body.address || "").trim();
    if (!name || !address) return bad(res, "Name and address are needed.");
    if (!["home", "work", "other"].includes(kind)) return bad(res, "Kind must be home, work or other.");
    if (householdId && !db.prepare("SELECT 1 FROM households WHERE id = ?").get(householdId)) return bad(res, "That family isn't there any more.");
    // The code is what callers press on the phone. Empty = the next free one; "1" = "01", "012" = "12".
    const used = usedCodes(householdId);
    if (!code) code = freeCode(used);
    else if (!/^\d{1,3}$/.test(code)) return bad(res, "The code must be 1 to 3 digits (or leave it empty).");
    else code = normalCode(code);
    if (!code) return bad(res, "All 999 codes are used.");
    if (used.has(code)) return bad(res, `Code ${code} is already used by ${used.get(code)}. Code ${freeCode(used) || "--"} is free.`);
    const check = await checkAddress(address);
    if (check.error) return bad(res, check.error);
    const id = newId("pl");
    const spoken = String(req.body.spoken || "").trim() || null;
    db.prepare("INSERT INTO places (id, household_id, code, kind, name, address, spoken, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, householdId, code, kind, name, address, spoken, check.point?.lat ?? null, check.point?.lng ?? null);
    audit(db, req.actor, "place_added", null, { id, code, name });
    res.json({ ok: true, id, code, found: check.found || null, warning: check.warning || null });
  });
  admin.patch("/places/:id", async (req, res) => {
    const p = db.prepare("SELECT * FROM places WHERE id = ?").get(req.params.id);
    if (!p) return res.status(404).json({ error: "not_found" });
    const name = String(req.body.name ?? p.name).trim();
    const address = String(req.body.address ?? p.address).trim();
    if (!name || !address) return bad(res, "Name and address are needed.");
    let point = address === p.address && p.lat != null ? { lat: p.lat, lng: p.lng } : null;
    let check = {};
    if (address !== p.address) {
      check = await checkAddress(address);
      if (check.error) return bad(res, check.error);
      point = check.point;
    }
    if (req.body.spoken != null) db.prepare("UPDATE places SET spoken = ? WHERE id = ?").run(String(req.body.spoken).trim() || null, p.id);
    db.prepare("UPDATE places SET name = ?, address = ?, lat = ?, lng = ? WHERE id = ?").run(name, address, point?.lat ?? null, point?.lng ?? null, p.id);
    audit(db, req.actor, "place_changed", null, { id: p.id });
    res.json({ ok: true, found: check.found || null, warning: check.warning || null });
  });
  admin.delete("/places/:id", (req, res) => {
    db.prepare("UPDATE places SET active = 0 WHERE id = ?").run(req.params.id);
    audit(db, req.actor, "place_removed", null, { id: req.params.id });
    res.json({ ok: true });
  });

  // --- drivers ---
  admin.get("/drivers", (_req, res) => {
    const rows = db.prepare("SELECT id FROM drivers ORDER BY name").all();
    res.json(rows.map(({ id }) => {
      const { pin_hash: pin, ...d } = driverNow(db, id, clock());
      return { ...d, has_pin: !!pin };
    }));
  });
  admin.post("/drivers/:id/pin", (req, res) => {
    const r = setPin(db, req.params.id, req.body.pin, req.actor);
    r.ok ? res.json(r) : bad(res, r.error);
  });
  admin.post("/drivers/:id/status", (req, res) => {
    if (!["online", "offline"].includes(req.body.status)) return bad(res, "Choose online or offline.");
    db.prepare("UPDATE drivers SET status = ?, paused_until = NULL WHERE id = ?").run(req.body.status, req.params.id);
    audit(db, req.actor, `driver_${req.body.status}`, null, { driverId: req.params.id });
    res.json({ ok: true });
  });
  admin.get("/drivers/:id/track", (req, res) => {
    const day = req.query.day || localParts(clock(), getSettings(db).timeZone).day;
    const from = new Date(`${day}T00:00:00Z`).getTime() - 864e5;
    const rows = db.prepare("SELECT at, lat, lng FROM driver_locations WHERE driver_id = ? AND at >= ? ORDER BY at LIMIT 20000").all(req.params.id, new Date(from).toISOString());
    const tz = getSettings(db).timeZone;
    res.json(rows.filter((p) => localParts(new Date(p.at), tz).day === day));
  });
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
    res.json(rows.map((b) => {
      const p = priorityOf(db, b);
      return { ...b, priority: p.level, priority_label: p.label };
    }));
  });
  admin.post("/bookings", async (req, res) => {
    const input = { ...req.body, phone: normalizePhone(req.body.phone) };
    // An address typed for this ride only is checked on the map first, like a saved place.
    for (const end of ["pickup", "dropoff"]) {
      const e = input[end];
      if (!e || e.placeId || !String(e.address || "").trim() || e.lat != null) continue;
      const check = await checkAddress(String(e.address).trim());
      if (check.error) return bad(res, check.error);
      input[end] = { address: String(e.address).trim(), ...(check.point || {}) };
    }
    const r = await bookRide(db, travel, input, clock(), getSettings(db, clock()), req.actor);
    if (r.ok) for (const b of r.bookings) notify(b, "booked");
    res.status(r.ok ? 200 : 400).json(r);
  });
  admin.get("/route", (req, res) => {
    const day = req.query.day || localParts(clock(), getSettings(db).timeZone).day;
    res.json(dayRoute(db, day));
  });
  admin.post("/route/refresh", async (req, res) => {
    const day = req.body.day || localParts(clock(), getSettings(db).timeZone).day;
    const r = await refreshDay(db, travel, day, getSettings(db, clock()), clock());
    res.json({ ...r, route: dayRoute(db, day) });
  });
  admin.get("/bookings/:id/preview", async (req, res) => {
    const r = await previewAccept(db, travel, req.params.id, getSettings(db, clock()), clock());
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
    const r = b.status === "accepted" ? await refreshDay(db, travel, b.day, getSettings(db, clock()), clock()) : null;
    const late = r?.route && (r.route.late[b.id] || Object.keys(r.route.late).length || Object.keys(r.route.over).length);
    res.json({ ok: true, booking: getBooking(db, b.id), warning: late ? "With the new address some pickups can't be on time. Check today's route." : null });
  });
  admin.post("/late", (req, res) => {
    const driverId = req.body.driverId || db.prepare("SELECT id FROM drivers ORDER BY rowid LIMIT 1").get()?.id;
    const r = runningLate(rideCtx(), driverId, req.body.minutes);
    res.status(r.ok ? 200 : 400).json(r);
  });
  admin.post("/bookings/:id/:action", async (req, res) => {
    const { id, action } = req.params;
    if (!ADMIN_ACTIONS.includes(action)) return res.status(404).json({ error: "unknown_action" });
    const driverId = req.body.driverId || db.prepare("SELECT id FROM drivers ORDER BY rowid LIMIT 1").get()?.id;
    if (["accept", "propose"].includes(action) && !driverId) return bad(res, "Add a driver first.");
    const r = await rideAction(rideCtx(), id, action, req.body, req.actor, driverId);
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
  // --- schedule changes: other hours, or no rides, for a day or a range (the driver app has the same) ---
  admin.get("/schedule", (_req, res) => res.json(scheduleView(db, getSettings(db), clock())));
  admin.post("/schedule", (req, res) => {
    const r = addChange(db, req.body, req.actor, getSettings(db), clock());
    r.ok ? res.json(r) : bad(res, r.error);
  });
  admin.delete("/schedule/:id", (req, res) => {
    const r = removeChange(db, req.params.id, req.actor);
    r.ok ? res.json(r) : bad(res, r.error);
  });
  admin.get("/reports", (req, res) => {
    const today = localParts(clock(), getSettings(db).timeZone).day;
    res.json(report(db, req.query.from || today, req.query.to || today, getSettings(db).timeZone));
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

  // --- feedback (comments, complaints, suggestions, requests) ---
  admin.get("/feedback", (_req, res) => res.json(listFeedback(db)));
  admin.post("/feedback", (req, res) => {
    const r = addFeedback(db, req.body, "admin", req.admin);
    r.ok ? res.json(r) : bad(res, r.error);
  });
  admin.patch("/feedback/:id", (req, res) => {
    const r = updateFeedback(db, req.params.id, req.body, req.actor);
    r.ok ? res.json(r) : bad(res, r.error);
  });

  app.use("/api/admin", admin);
  return app;
}

// Background work every 20 seconds: reminders, sending what's due through Fonory, recording spoken pieces, and the
// daily database copy.
export function startLoops(db, env = process.env) {
  const client = fonoryClient(env);
  const speak = yiddishVoice(env);
  const dir = env.RECORDINGS_DIR || path.join(path.dirname(env.DB_FILE || "data/dispatch.db"), "recordings");
  const backups = env.BACKUP_DIR || path.join(path.dirname(env.DB_FILE || "data/dispatch.db"), "backups");
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
      if (backupDue(backups)) backupNow(db, backups, Number(env.BACKUP_KEEP) || 14);
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
