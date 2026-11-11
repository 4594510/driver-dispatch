// Bookings: taking a ride request, checking it against the rules and the seats, and saving it as pending for the driver.
// Until route planning is built (stage 3), seats are checked on a time line: each ride holds its seats from the start
// of its pickup window until the latest it could arrive (window + the 30-minute driving limit). That is cautious: it
// may refuse a ride the real route could fit, never the other way round.
import { audit, newId, nowIso } from "./db.js";
import { checkRequest, localParts, DEFAULT_SETTINGS } from "./rules.js";
import { planSeats, DEFAULT_LAYOUT } from "./seating.js";

const HOLDING = ["accepted", "proposed", "picked_up"];

export function approvedPhone(db, number) {
  return db.prepare("SELECT * FROM phones WHERE number = ? AND active = 1").get(number) || null;
}

// Turn rides with times into stop indexes for the seating engine.
export function timeline(rides, settings = DEFAULT_SETTINGS) {
  const events = [];
  for (const r of rides) {
    events.push({ t: r.pickup_minute, kind: 1, r });
    events.push({ t: r.pickup_minute + r.window_minutes + settings.maxTripMinutes, kind: 0, r });
  }
  events.sort((a, b) => a.t - b.t || a.kind - b.kind); // drop-offs before pickups at the same minute
  const idx = new Map();
  events.forEach((e, i) => {
    const cur = idx.get(e.r) || {};
    if (e.kind === 1) cur.pickup = i;
    else cur.dropoff = i;
    idx.set(e.r, cur);
  });
  return rides.map((r) => ({
    id: r.id,
    men: r.men,
    women: r.women,
    together: !!r.together,
    seats: r.seats ? JSON.parse(r.seats) : undefined,
    ...idx.get(r),
  }));
}

export function seatCheck(db, day, candidates, settings = DEFAULT_SETTINGS, layout = DEFAULT_LAYOUT) {
  const holding = db
    .prepare(`SELECT * FROM bookings WHERE day = ? AND status IN (${HOLDING.map(() => "?").join(",")})`)
    .all(day, ...HOLDING)
    .filter((h) => !candidates.some((c) => c.id === h.id));
  return planSeats(timeline([...holding, ...candidates], settings), layout);
}

// Create a ride request (and its return trip, if asked). input:
// { phone, passengerId?, riderName?, men, women, together, pickup: {placeId?|address}, dropoff: {...}, pickupMinute?,
//   window, returnMinute? }
// Returns { ok: true, bookings: [...] } or { ok: false, errors: [...] }.
export function requestRide(db, input, now = new Date(), settings = DEFAULT_SETTINGS) {
  const phone = approvedPhone(db, input.phone);
  if (!phone) return { ok: false, errors: ["not_registered"] };

  const day = localParts(now, settings.timeZone).day;
  const check = checkRequest(now, { day, pickupMinute: input.pickupMinute ?? null, window: input.window, returnMinute: input.returnMinute }, settings);
  const errors = [...check.errors];
  const men = Number(input.men) || 0;
  const women = Number(input.women) || 0;
  if (men + women === 0) errors.push("no_riders");

  const place = (p) => {
    if (!p) return null;
    if (p.placeId) {
      const row = db
        .prepare("SELECT * FROM places WHERE id = ? AND active = 1 AND (household_id IS NULL OR household_id = ?)")
        .get(p.placeId, phone.household_id);
      return row ? { id: row.id, address: row.address } : null;
    }
    return p.address ? { id: null, address: p.address } : null;
  };
  const from = place(input.pickup);
  const to = place(input.dropoff);
  if (!from) errors.push("no_pickup");
  if (!to) errors.push("no_dropoff");
  if (errors.length) return { ok: false, errors };

  let riderName = input.riderName || "";
  if (input.passengerId) {
    const p = db.prepare("SELECT * FROM passengers WHERE id = ? AND active = 1").get(input.passengerId);
    if (!p) return { ok: false, errors: ["unknown_passenger"] };
    riderName = p.name;
  }

  const base = {
    day,
    household_id: phone.household_id,
    booked_by_phone: phone.number,
    passenger_id: input.passengerId || null,
    rider_name: riderName,
    men,
    women,
    together: input.together ? 1 : 0,
    window_minutes: input.window,
  };
  const rides = [
    { ...base, id: newId("bk"), pickup_place_id: from.id, pickup_address: from.address, dropoff_place_id: to.id, dropoff_address: to.address, pickup_minute: check.pickupMinute, return_of: null },
  ];
  if (input.returnMinute != null) {
    rides.push({ ...base, id: newId("bk"), pickup_place_id: to.id, pickup_address: to.address, dropoff_place_id: from.id, dropoff_address: from.address, pickup_minute: input.returnMinute, return_of: rides[0].id });
  }

  const seats = seatCheck(db, day, rides, settings);
  if (!seats.ok) return { ok: false, errors: ["no_seats"], detail: seats.reason };

  const insert = db.prepare(`INSERT INTO bookings (id, day, household_id, booked_by_phone, passenger_id, rider_name, men, women,
    together, pickup_place_id, pickup_address, dropoff_place_id, dropoff_address, pickup_minute, window_minutes, return_of,
    status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`);
  const at = nowIso();
  for (const r of rides) {
    insert.run(r.id, r.day, r.household_id, r.booked_by_phone, r.passenger_id, r.rider_name, r.men, r.women, r.together,
      r.pickup_place_id, r.pickup_address, r.dropoff_place_id, r.dropoff_address, r.pickup_minute, r.window_minutes,
      r.return_of, at, at);
    audit(db, `phone:${phone.number}`, "requested", r.id, { men, women, pickup_minute: r.pickup_minute });
  }
  return { ok: true, bookings: rides.map((r) => getBooking(db, r.id)) };
}

export function getBooking(db, id) {
  return db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) || null;
}

// Driver accepts: seats are checked again (things may have changed) and saved on the booking.
export function acceptBooking(db, id, driverId, settings = DEFAULT_SETTINGS) {
  const b = getBooking(db, id);
  if (!b) return { ok: false, errors: ["not_found"] };
  if (!["pending", "proposed"].includes(b.status)) return { ok: false, errors: ["not_pending"] };
  const seats = seatCheck(db, b.day, [b], settings);
  if (!seats.ok) return { ok: false, errors: ["no_seats"], detail: seats.reason };
  const plan = seats.plan;
  const save = db.prepare("UPDATE bookings SET seats = ?, updated_at = ? WHERE id = ?");
  const at = nowIso();
  for (const [bid, s] of Object.entries(plan)) save.run(JSON.stringify(s), at, bid);
  db.prepare("UPDATE bookings SET status = 'accepted', driver_id = ?, updated_at = ? WHERE id = ?").run(driverId, at, id);
  audit(db, `driver:${driverId}`, "accepted", id);
  return { ok: true, booking: getBooking(db, id) };
}

const TRANSITIONS = {
  reject: { from: ["pending", "proposed"], to: "rejected" },
  cancel: { from: ["pending", "proposed", "accepted"], to: "cancelled" },
  pickup: { from: ["accepted"], to: "picked_up" },
  done: { from: ["picked_up", "accepted"], to: "completed" },
  no_show: { from: ["accepted"], to: "no_show" },
};

// reject / cancel / pickup / done / no_show. Seats are freed simply by the status leaving the holding set.
export function changeStatus(db, id, action, actor) {
  const t = TRANSITIONS[action];
  const b = getBooking(db, id);
  if (!t || !b) return { ok: false, errors: ["not_found"] };
  if (!t.from.includes(b.status)) return { ok: false, errors: ["wrong_status"], status: b.status };
  db.prepare("UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?").run(t.to, nowIso(), id);
  audit(db, actor, action, id, { from: b.status });
  return { ok: true, booking: getBooking(db, id) };
}

// The driver suggests another pickup time; the passenger is asked to approve it.
export function proposeTime(db, id, minute, driverId) {
  const b = getBooking(db, id);
  if (!b || b.status !== "pending") return { ok: false, errors: ["not_pending"] };
  db.prepare("UPDATE bookings SET status = 'proposed', proposed_minute = ?, updated_at = ? WHERE id = ?").run(minute, nowIso(), id);
  audit(db, `driver:${driverId}`, "proposed_time", id, { minute });
  return { ok: true, booking: getBooking(db, id) };
}
