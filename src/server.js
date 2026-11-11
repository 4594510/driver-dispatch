// The server: the admin API now; the Fonory hotline API, driver app API and dashboard pages come in later stages.
// Admin calls need the ADMIN_TOKEN in an "Authorization: Bearer" header until real admin logins are built (stage 2).
import express from "express";
import crypto from "node:crypto";
import { openDb, newId, nowIso, audit } from "./db.js";
import { requestRide, acceptBooking, changeStatus, proposeTime, getBooking } from "./bookings.js";

export function createApp(db = openDb(), env = process.env) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  const admin = express.Router();
  admin.use((req, res, next) => {
    const token = (req.get("authorization") || "").replace(/^Bearer /, "");
    const want = env.ADMIN_TOKEN || "";
    const ok = want && token.length === want.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(want));
    if (!ok) return res.status(401).json({ error: "unauthorized" });
    next();
  });

  admin.post("/households", (req, res) => {
    const id = newId("hh");
    db.prepare("INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)").run(id, req.body.name, nowIso());
    audit(db, "admin", "household_added", null, { id });
    res.json({ id });
  });
  admin.get("/households", (_req, res) => res.json(db.prepare("SELECT * FROM households ORDER BY name").all()));

  admin.post("/passengers", (req, res) => {
    const { householdId, name, gender, notes = "" } = req.body;
    if (!["m", "f"].includes(gender)) return res.status(400).json({ error: "gender must be m or f" });
    const id = newId("ps");
    db.prepare("INSERT INTO passengers (id, household_id, name, gender, notes) VALUES (?, ?, ?, ?, ?)").run(id, householdId, name, gender, notes);
    audit(db, "admin", "passenger_added", null, { id });
    res.json({ id });
  });

  admin.post("/phones", (req, res) => {
    const { number, householdId, passengerId = null, notify = "both" } = req.body;
    db.prepare("INSERT INTO phones (number, household_id, passenger_id, notify) VALUES (?, ?, ?, ?)").run(number, householdId, passengerId, notify);
    audit(db, "admin", "phone_added", null, { number });
    res.json({ number });
  });
  admin.delete("/phones/:number", (req, res) => {
    db.prepare("UPDATE phones SET active = 0 WHERE number = ?").run(req.params.number);
    audit(db, "admin", "phone_removed", null, { number: req.params.number });
    res.json({ ok: true });
  });

  admin.post("/places", (req, res) => {
    const { householdId = null, code, kind = "other", name, address } = req.body;
    const id = newId("pl");
    db.prepare("INSERT INTO places (id, household_id, code, kind, name, address) VALUES (?, ?, ?, ?, ?, ?)").run(id, householdId, code, kind, name, address);
    audit(db, "admin", "place_added", null, { id });
    res.json({ id });
  });

  admin.post("/drivers", (req, res) => {
    const id = newId("drv");
    db.prepare("INSERT INTO drivers (id, name, phone) VALUES (?, ?, ?)").run(id, req.body.name, req.body.phone);
    audit(db, "admin", "driver_added", null, { id });
    res.json({ id });
  });

  admin.get("/bookings", (req, res) => {
    const day = req.query.day;
    const rows = day
      ? db.prepare("SELECT * FROM bookings WHERE day = ? ORDER BY pickup_minute").all(day)
      : db.prepare("SELECT * FROM bookings ORDER BY day DESC, pickup_minute LIMIT 500").all();
    res.json(rows);
  });
  admin.post("/bookings", (req, res) => {
    const r = requestRide(db, req.body);
    res.status(r.ok ? 200 : 400).json(r);
  });
  admin.post("/bookings/:id/:action", (req, res) => {
    const { id, action } = req.params;
    const driverId = req.body.driverId || db.prepare("SELECT id FROM drivers ORDER BY rowid LIMIT 1").get()?.id;
    if (["accept", "propose"].includes(action) && !driverId) return res.status(400).json({ ok: false, errors: ["no_driver"] });
    let r;
    if (action === "accept") r = acceptBooking(db, id, driverId);
    else if (action === "propose") r = proposeTime(db, id, req.body.minute, driverId);
    else r = changeStatus(db, id, action, "admin");
    res.status(r.ok ? 200 : 400).json(r);
  });
  admin.get("/bookings/:id", (req, res) => {
    const b = getBooking(db, req.params.id);
    b ? res.json(b) : res.status(404).json({ error: "not_found" });
  });
  admin.get("/audit", (_req, res) => res.json(db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 500").all()));

  app.use("/api/admin", admin);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`dispatch listening on ${port}`));
}
