// The driver app's API (stage 5), under /api/driver. The app signs in with the driver's phone number and a PIN an
// admin set on the dashboard, and then sends its token as "Authorization: Bearer <token>". Tokens last 90 days and are
// stored hashed.
//
// Actions sent with a "key" (the app makes one per action) are done once: an action made without signal and sent
// again later gets the first answer back.
import express from "express";
import crypto from "node:crypto";
import { nowIso, audit } from "./db.js";
import { hashPassword, checkPassword, tooManyTries, noteFailure } from "./auth.js";
import { getBooking } from "./bookings.js";
import { previewAccept, refreshDay, dayRoute, reorderRoute, autoRoute } from "./dispatch.js";
import { rideAction, runningLate, tellLate, DRIVER_ACTIONS } from "./actions.js";
import { localParts } from "./rules.js";

const SESSION_DAYS = 90;
const STATUSES = ["online", "offline", "paused"];
const REFRESH_SECONDS = 120; // re-time the day from the driver's GPS at most this often
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function pinProblem(pin) {
  return /^\d{4,8}$/.test(String(pin ?? "")) ? null : "The PIN must be 4 to 8 digits.";
}

export function setPin(db, driverId, pin, actor) {
  const problem = pinProblem(pin);
  if (problem) return { ok: false, error: problem };
  const r = db.prepare("UPDATE drivers SET pin_hash = ? WHERE id = ?").run(hashPassword(String(pin)), driverId);
  if (!r.changes) return { ok: false, error: "Unknown driver." };
  db.prepare("DELETE FROM driver_sessions WHERE driver_id = ?").run(driverId); // a new PIN signs the old phone out
  audit(db, actor, "driver_pin_set", null, { driverId });
  return { ok: true };
}

// Paused drivers come back online by themselves when the pause runs out.
export function driverNow(db, id, now = new Date()) {
  const d = db.prepare("SELECT * FROM drivers WHERE id = ?").get(id);
  if (d?.status === "paused" && d.paused_until && d.paused_until <= now.toISOString()) {
    db.prepare("UPDATE drivers SET status = 'online', paused_until = NULL WHERE id = ?").run(id);
    return { ...d, status: "online", paused_until: null };
  }
  return d;
}

// Is a driver taking rides right now? (The phone line says "sent to the driver" or "the driver isn't available".)
export function driverAvailable(db, now = new Date()) {
  const ids = db.prepare("SELECT id FROM drivers").all();
  return ids.some(({ id }) => driverNow(db, id, now)?.status === "online");
}

const publicDriver = (d) => ({ id: d.id, name: d.name, phone: d.phone, status: d.status, paused_until: d.paused_until });

// ctx(): { db, travel, settings, now, notify } for this request.
export function driverRouter(db, ctxFor) {
  const r = express.Router();

  r.post("/login", (req, res) => {
    const digits = String(req.body?.phone || "").replace(/\D/g, "").slice(-10);
    const key = `driver|${req.ip}|${digits}`;
    if (tooManyTries(key)) return res.status(429).json({ error: "Too many tries. Wait 15 minutes." });
    const d = digits.length === 10 ? db.prepare("SELECT * FROM drivers WHERE substr(phone, -10) = ?").get(digits) : null;
    if (!d || !d.pin_hash || !checkPassword(String(req.body?.pin || ""), d.pin_hash)) {
      noteFailure(key);
      return res.status(401).json({ error: "Wrong phone number or PIN." });
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    db.prepare("INSERT INTO driver_sessions (token_hash, driver_id, expires_at) VALUES (?, ?, ?)").run(sha(token), d.id, expires);
    audit(db, `driver:${d.id}`, "signed_in");
    res.json({ token, driver: publicDriver(d) });
  });

  r.use((req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.get("authorization") || "");
    const row = m && db.prepare("SELECT * FROM driver_sessions WHERE token_hash = ?").get(sha(m[1]));
    if (!row || row.expires_at < nowIso()) return res.status(401).json({ error: "Please sign in." });
    req.driverId = row.driver_id;
    req.tokenHash = row.token_hash;
    req.actor = `driver:${row.driver_id}`;
    next();
  });

  // Once-only actions: the same key gives the same answer.
  const once = (handler) => async (req, res) => {
    const key = req.body?.key ? `${req.driverId}:${String(req.body.key).slice(0, 80)}` : null;
    if (key) {
      const seen = db.prepare("SELECT result FROM driver_actions WHERE key = ?").get(key);
      if (seen) return res.json({ ...JSON.parse(seen.result), repeated: true });
    }
    const out = await handler(req);
    if (key) db.prepare("INSERT OR IGNORE INTO driver_actions (key, driver_id, at, result) VALUES (?, ?, ?, ?)").run(key, req.driverId, nowIso(), JSON.stringify(out));
    res.status(out.ok ? 200 : 400).json(out);
  };

  r.post("/logout", (req, res) => {
    db.prepare("DELETE FROM driver_sessions WHERE token_hash = ?").run(req.tokenHash);
    res.json({ ok: true });
  });

  // Everything the app shows: the driver, today's route with its stops, and the requests waiting for an answer.
  r.get("/today", (req, res) => {
    const c = ctxFor();
    const d = driverNow(db, req.driverId, c.now);
    const here = localParts(c.now, c.settings.timeZone);
    res.json({ driver: publicDriver(d), ...todayFor(db, here) });
  });

  r.post("/status", once(async (req) => {
    const c = ctxFor();
    const status = req.body?.status;
    if (!STATUSES.includes(status)) return { ok: false, errors: ["bad_status"] };
    const minutes = Number(req.body?.minutes) || 0;
    const until = status === "paused" && minutes > 0 ? new Date(c.now.getTime() + Math.min(minutes, 480) * 60000).toISOString() : null;
    db.prepare("UPDATE drivers SET status = ?, paused_until = ? WHERE id = ?").run(status, until, req.driverId);
    audit(db, req.actor, `driver_${status}`, null, until ? { until } : {});
    return { ok: true, driver: publicDriver(driverNow(db, req.driverId, c.now)) };
  }));

  // GPS points, one or a batch (the app keeps them while there's no signal). The newest is the live position.
  r.post("/location", async (req, res) => {
    const c = ctxFor();
    const raw = Array.isArray(req.body?.points) ? req.body.points : [req.body];
    const pts = raw
      .map((p) => ({ lat: Number(p?.lat), lng: Number(p?.lng), at: p?.at ? new Date(p.at) : c.now, accuracy: p?.accuracy ?? null, speed: p?.speed ?? null }))
      .filter((p) => Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && Number.isFinite(p.lat) && Number.isFinite(p.lng) && !Number.isNaN(p.at.getTime()))
      .slice(0, 2000);
    if (!pts.length) return res.status(400).json({ ok: false, errors: ["no_points"] });
    const add = db.prepare("INSERT INTO driver_locations (driver_id, at, lat, lng, accuracy, speed) VALUES (?, ?, ?, ?, ?, ?)");
    for (const p of pts) add.run(req.driverId, (p.at > c.now ? c.now : p.at).toISOString(), p.lat, p.lng, p.accuracy, p.speed);
    const last = pts.reduce((a, b) => (b.at > a.at ? b : a));
    const d = db.prepare("SELECT last_seen_at FROM drivers WHERE id = ?").get(req.driverId);
    if (!d.last_seen_at || last.at.toISOString() >= d.last_seen_at) {
      db.prepare("UPDATE drivers SET last_lat = ?, last_lng = ?, last_seen_at = ? WHERE id = ?").run(last.lat, last.lng, (last.at > c.now ? c.now : last.at).toISOString(), req.driverId);
    }
    // Arrival times from where the driver really is, now and then.
    const day = localParts(c.now, c.settings.timeZone).day;
    const route = db.prepare("SELECT updated_at FROM routes WHERE day = ?").get(day);
    let refreshed = false;
    if (route && c.now.getTime() - new Date(route.updated_at).getTime() >= REFRESH_SECONDS * 1000) {
      await refreshDay(db, c.travel, day, c.settings, c.now);
      tellLate(c, day);
      refreshed = true;
    }
    res.json({ ok: true, saved: pts.length, refreshed });
  });

  r.get("/requests/:id/preview", async (req, res) => {
    const c = ctxFor();
    const p = await previewAccept(db, c.travel, req.params.id, c.settings, c.now);
    res.status(p.ok ? 200 : 400).json(p.ok || p.before ? { ...p, names: namesFor(db, p) } : p);
  });

  r.post("/bookings/:id/:action", once(async (req) => {
    const { id, action } = req.params;
    if (!DRIVER_ACTIONS.includes(action)) return { ok: false, errors: ["unknown_action"] };
    return rideAction(ctxFor(), id, action, req.body, req.actor, req.driverId);
  }));

  r.post("/late", once(async (req) => runningLate(ctxFor(), req.driverId, req.body?.minutes)));

  r.post("/route/order", once(async (req) => {
    const c = ctxFor();
    const day = localParts(c.now, c.settings.timeZone).day;
    const out = await reorderRoute(db, c.travel, day, req.body?.stops, c.settings, c.now);
    if (out.ok) audit(db, req.actor, "route_reordered", null, { day });
    return out;
  }));
  r.post("/route/auto", once(async () => {
    const c = ctxFor();
    const day = localParts(c.now, c.settings.timeZone).day;
    return autoRoute(db, c.travel, day, c.settings, c.now);
  }));

  return r;
}

function namesFor(db, p) {
  const ids = new Set([...(p.before?.stops || []), ...(p.after?.stops || [])].map((s) => s.booking_id));
  return Object.fromEntries([...ids].map((id) => [id, getBooking(db, id)?.rider_name || ""]));
}

// Today's route with what the driver needs at each stop, and the waiting requests.
export function todayFor(db, here) {
  const route = dayRoute(db, here.day);
  const extra = (id) => {
    const b = getBooking(db, id);
    const p = b?.passenger_id ? db.prepare("SELECT notes FROM passengers WHERE id = ?").get(b.passenger_id) : null;
    return { phone: b?.booked_by_phone, notes: p?.notes || "", together: !!b?.together, b };
  };
  const stops = route.stops.map((s, i) => {
    const { b, ...e } = extra(s.booking_id);
    const lat = s.kind === "pickup" ? b?.pickup_lat : b?.dropoff_lat;
    const lng = s.kind === "pickup" ? b?.pickup_lng : b?.dropoff_lng;
    return { ...s, ...e, lat, lng, index: i, seatsHere: route.seatsByStop.find((x) => x.stop === i)?.rows || null };
  });
  const next = stops.find((s) => (s.kind === "pickup" && s.status === "accepted") || (s.kind === "dropoff" && s.status === "picked_up")) || null;
  const requests = db
    .prepare("SELECT * FROM bookings WHERE day = ? AND status IN ('pending', 'proposed') ORDER BY pickup_minute")
    .all(here.day)
    .map((b) => ({
      id: b.id, status: b.status, rider_name: b.rider_name, men: b.men, women: b.women, together: !!b.together,
      from: b.pickup_address, to: b.dropoff_address, window: [b.pickup_minute, b.pickup_minute + b.window_minutes],
      proposed_minute: b.proposed_minute, phone: b.booked_by_phone, return_of: b.return_of,
    }));
  const manual = db.prepare("SELECT manual FROM routes WHERE day = ?").get(here.day)?.manual;
  return {
    day: here.day,
    minute: here.minute,
    route: { stops, driveMinutes: route.driveMinutes, estimated: route.estimated, updatedAt: route.updatedAt, manual: !!manual },
    next,
    requests,
  };
}
