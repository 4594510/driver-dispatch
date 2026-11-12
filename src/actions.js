// What the driver (in the app) or an admin (on the dashboard) does to a ride, in one place, with the messages to the
// caller that go with it. ctx: { db, travel, settings, now, notify(booking, kind, payload) }.
import { audit } from "./db.js";
import { changeStatus, proposeTime, getBooking } from "./bookings.js";
import { acceptRide, refreshDay } from "./dispatch.js";
import { localParts } from "./rules.js";

export const DRIVER_ACTIONS = ["accept", "reject", "propose", "pickup", "done", "no_show"];
export const ADMIN_ACTIONS = [...DRIVER_ACTIONS, "cancel"];

// Returns { ok, booking } or { ok: false, errors }.
export async function rideAction(ctx, id, action, body, actor, driverId) {
  const { db, travel, settings, now, notify } = ctx;
  const was = getBooking(db, id);
  if (!was) return { ok: false, errors: ["not_found"] };
  if (action === "accept") {
    const r = await acceptRide(db, travel, id, driverId, settings, now, { override: !!body?.override });
    if (r.ok) notify(r.booking, "accepted");
    return r;
  }
  if (action === "propose") {
    const minute = Number(body?.minute);
    if (!Number.isInteger(minute) || minute < settings.openMinute || minute > settings.closeMinute) return { ok: false, errors: ["bad_time"] };
    const r = proposeTime(db, id, minute, driverId);
    if (r.ok) notify(r.booking, "time_change", { oldMinute: was.pickup_minute, newMinute: minute });
    return r;
  }
  const r = changeStatus(db, id, action, actor, now, settings);
  if (!r.ok) return r;
  if (["accepted", "picked_up"].includes(was.status)) await refreshDay(db, travel, was.day, settings, now);
  if (action === "reject") notify(r.booking, "not_taken");
  if (action === "cancel" && !actor.startsWith("phone:")) notify(r.booking, "cancelled");
  return { ok: true, booking: getBooking(db, id) };
}

// The driver says they're running late by some minutes. Everyone still waiting for a pickup today whose new arrival
// is past their window hears the new time (once per press); the route's times move by the same minutes.
export function runningLate(ctx, driverId, minutes) {
  const { db, settings, now, notify } = ctx;
  const m = Math.round(Number(minutes));
  if (!Number.isFinite(m) || m < 1 || m > 120) return { ok: false, errors: ["bad_minutes"] };
  const day = localParts(now, settings.timeZone).day;
  const rows = db.prepare("SELECT * FROM bookings WHERE day = ? AND status = 'accepted' ORDER BY coalesce(eta_minute, pickup_minute)").all(day);
  const told = [];
  for (const b of rows) {
    const eta = (b.eta_minute ?? b.pickup_minute) + m;
    db.prepare("UPDATE bookings SET eta_minute = ? WHERE id = ?").run(eta, b.id);
    if (eta > b.pickup_minute + b.window_minutes) {
      notify({ ...b, eta_minute: eta }, "late", { minute: eta });
      told.push(b.id);
    }
  }
  audit(db, `driver:${driverId}`, "running_late", null, { minutes: m, told });
  return { ok: true, moved: rows.length, told };
}

// After a GPS refresh: a waiting rider whose arrival slipped more than LATE_MARGIN past their window hears the new
// time, once per ride (a press of "running late" counts too).
const LATE_MARGIN = 5;
export function tellLate(ctx, day) {
  const { db, notify } = ctx;
  const rows = db.prepare(`SELECT * FROM bookings b WHERE day = ? AND status = 'accepted' AND eta_minute > pickup_minute + window_minutes + ?
    AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.booking_id = b.id AND d.kind = 'late')`).all(day, LATE_MARGIN);
  for (const b of rows) notify(b, "late", { minute: b.eta_minute });
  return rows.length;
}
