// Stops on the way of a ride (Shloime and the driver, 2026-11-17: "add stops"): pick up, stop at one or more places
// (the store, a second address), then drop off. The riders stay on board the whole time, so the seats don't change.
// The planner drives the stops in order right before the ride's drop-off (route.js timeRoute, ride.via); the driver
// presses "Done here" at each one. A ride with stops has no 30-minute limit on board: the caller asked for the detour.
import { newId, nowIso, audit } from "./db.js";
import { getBooking } from "./bookings.js";

const OPEN = ["pending", "proposed", "accepted", "picked_up"];
export const ROUTED_STATUSES = ["accepted", "picked_up"];
export const MAX_STOPS = 5;

// A ride's stops in order: [{ id, n, place_id, address, lat, lng, done_at }].
export function stopsFor(db, bookingId) {
  if (!bookingId) return [];
  return db.prepare("SELECT * FROM ride_stops WHERE booking_id = ? ORDER BY n").all(bookingId);
}

// The stops as the apps show them: the saved place's name (when it says more than the address) and done or not.
export function stopsView(db, bookingId) {
  return stopsFor(db, bookingId).map((s) => {
    const name = s.place_id ? db.prepare("SELECT name FROM places WHERE id = ?").get(s.place_id)?.name || "" : "";
    return { id: s.id, n: s.n, place: name && name.trim() !== s.address.trim() ? name : "", address: s.address, done: !!s.done_at };
  });
}

// Add a stop at the end of a ride's stops. where: { placeId } or { address }. findPoint(address) -> { point } | { error }
// (the server's Google check). Returns { ok, stop, routed } or { ok: false, errors | error }.
export async function addStop(db, travel, bookingId, where, actor, findPoint) {
  const b = getBooking(db, bookingId);
  if (!b) return { ok: false, errors: ["not_found"] };
  if (!OPEN.includes(b.status)) return { ok: false, errors: ["wrong_status"] };
  const have = stopsFor(db, bookingId);
  if (have.length >= MAX_STOPS) return { ok: false, errors: ["too_many_stops"] };
  let placeId = null;
  let address = "";
  let point = null;
  if (where?.placeId) {
    const p = db.prepare("SELECT * FROM places WHERE id = ? AND active = 1").get(String(where.placeId));
    if (!p) return { ok: false, errors: ["no_place"] };
    placeId = p.id;
    address = p.address;
    point = p.lat != null ? { lat: p.lat, lng: p.lng } : await travel.geocode(p.address);
  } else {
    address = String(where?.address || "").trim().slice(0, 200);
    if (!address) return { ok: false, errors: ["no_place"] };
    if (findPoint) {
      const check = await findPoint(address);
      if (check?.error) return { ok: false, error: check.error };
      point = check?.point || null;
    }
    point ||= await travel.geocode(address);
  }
  if (!point) return { ok: false, errors: ["not_on_map"] };
  const stop = { id: newId("st"), booking_id: bookingId, n: (have.at(-1)?.n || 0) + 1, place_id: placeId, address, lat: point.lat, lng: point.lng, created_at: nowIso() };
  db.prepare("INSERT INTO ride_stops (id, booking_id, n, place_id, address, lat, lng, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(stop.id, stop.booking_id, stop.n, stop.place_id, stop.address, stop.lat, stop.lng, stop.created_at);
  audit(db, actor, "stop_added", bookingId, { stop: stop.id, address });
  return { ok: true, stop, routed: ROUTED_STATUSES.includes(b.status), day: b.day };
}

// Take a stop off its ride (not one already done).
export function removeStop(db, stopId, actor) {
  const s = db.prepare("SELECT * FROM ride_stops WHERE id = ?").get(String(stopId));
  if (!s) return { ok: false, errors: ["not_found"] };
  if (s.done_at) return { ok: false, errors: ["stop_done"] };
  db.prepare("DELETE FROM ride_stops WHERE id = ?").run(s.id);
  audit(db, actor, "stop_removed", s.booking_id, { stop: s.id, address: s.address });
  const b = getBooking(db, s.booking_id);
  return { ok: true, routed: !!b && ROUTED_STATUSES.includes(b.status), day: b?.day };
}

// The driver was at the stop ("Done here"). Pressing it twice is fine.
export function stopDone(db, stopId, actor) {
  const s = db.prepare("SELECT * FROM ride_stops WHERE id = ?").get(String(stopId));
  if (!s) return { ok: false, errors: ["not_found"] };
  if (!s.done_at) {
    db.prepare("UPDATE ride_stops SET done_at = ? WHERE id = ?").run(nowIso(), s.id);
    audit(db, actor, "stop_done", s.booking_id, { stop: s.id });
  }
  const b = getBooking(db, s.booking_id);
  return { ok: true, routed: !!b && ROUTED_STATUSES.includes(b.status), day: b?.day };
}
