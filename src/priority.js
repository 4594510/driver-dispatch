// Priority levels, set by an admin for a whole family or for one person, always or for a stretch of time.
//
// A ride's priority is the highest level among the rules that cover it: a rule for its family, or for its rider (the
// person picked on the booking, else the person the calling phone belongs to), whose time range holds the ride's
// pickup time. Ranges are local times ("2026-11-12T10:00"), so they compare as text; an empty end means no end.
//
// What priority does (see dispatch.js and route.js): the driver sees higher-priority requests first and marked; when
// accepting one ride would leave no room for a waiting higher-priority one, the preview says so; and when the planner
// chooses between stop orders, waiting by a higher-priority rider counts more. It never moves a ride that is
// already accepted later than it was promised: that rule stays above priority.
import { audit, newId, nowIso } from "./db.js";

export const LEVELS = { 0: "Normal", 1: "High", 2: "Top" };
export const MAX_LEVEL = 2;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export const stampOf = (day, minute) => `${day}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

// A booking row (or prepared ride): { level, label, rule } for its pickup time.
export function priorityOf(db, b) {
  if (!b?.household_id) return { level: 0, label: LEVELS[0], rule: null };
  const person = b.passenger_id || (b.booked_by_phone ? db.prepare("SELECT passenger_id FROM phones WHERE number = ?").get(b.booked_by_phone)?.passenger_id : null) || null;
  const at = stampOf(b.day, b.pickup_minute);
  const rule = db.prepare(`SELECT * FROM priorities WHERE active = 1
      AND ((passenger_id IS NULL AND household_id = ?) OR (passenger_id IS NOT NULL AND passenger_id = ?))
      AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?)
    ORDER BY level DESC LIMIT 1`).get(b.household_id, person, at, at);
  const level = rule?.level ?? 0;
  return { level, label: LEVELS[level], rule: rule?.id ?? null };
}

export function listPriorities(db) {
  return db.prepare(`SELECT p.*, h.name AS household_name, ps.name AS passenger_name FROM priorities p
    JOIN households h ON h.id = p.household_id LEFT JOIN passengers ps ON ps.id = p.passenger_id
    WHERE p.active = 1 ORDER BY h.name, p.passenger_id IS NOT NULL, p.starts_at`).all().map((r) => ({ ...r, label: LEVELS[r.level] }));
}

// input: { householdId, passengerId?, level: 1 | 2, from?: "YYYY-MM-DDTHH:MM", to?, note? }
export function addPriority(db, input, actor) {
  const level = Number(input?.level);
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) return { ok: false, error: "Choose High or Top." };
  const hh = db.prepare("SELECT id FROM households WHERE id = ? AND active = 1").get(input.householdId);
  if (!hh) return { ok: false, error: "Unknown family." };
  const passengerId = input.passengerId || null;
  if (passengerId && !db.prepare("SELECT 1 FROM passengers WHERE id = ? AND household_id = ? AND active = 1").get(passengerId, hh.id)) {
    return { ok: false, error: "That person isn't in this family." };
  }
  const from = input.from ? String(input.from).slice(0, 16) : null;
  const to = input.to ? String(input.to).slice(0, 16) : null;
  if ((from && !STAMP.test(from)) || (to && !STAMP.test(to))) return { ok: false, error: "Give the dates and times as date and time." };
  if (from && to && to <= from) return { ok: false, error: "The end must be after the start." };
  const id = newId("pri");
  const note = String(input.note || "").trim().slice(0, 200);
  db.prepare(`INSERT INTO priorities (id, household_id, passenger_id, level, starts_at, ends_at, note, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, hh.id, passengerId, level, from, to, note, actor, nowIso());
  audit(db, actor, "priority_added", null, { id, householdId: hh.id, passengerId, level, from, to });
  return { ok: true, id };
}

export function removePriority(db, id, actor) {
  const r = db.prepare("UPDATE priorities SET active = 0 WHERE id = ? AND active = 1").run(id);
  if (!r.changes) return { ok: false, error: "Unknown priority." };
  audit(db, actor, "priority_removed", null, { id });
  return { ok: true };
}
