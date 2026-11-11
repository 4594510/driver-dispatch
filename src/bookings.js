// Bookings: taking a ride request, checking it against the rules and the seats, and saving it as pending for the driver.
// Until route planning is built (stage 3), seats are checked on a time line: each ride holds its seats from the start
// of its pickup window until the latest it could arrive (window + the 30-minute driving limit). That is cautious: it
// may refuse a ride the real route could fit, never the other way round.
import { audit, newId, nowIso } from "./db.js";
import { checkRequest, localParts, DEFAULT_SETTINGS } from "./rules.js";
import { planSeats, DEFAULT_LAYOUT } from "./seating.js";
import { seatPeople, peopleForFamily } from "./relations.js";

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
    people: r.people || [],
    seats: r.seats ? JSON.parse(r.seats) : undefined,
    ...idx.get(r),
  }));
}

export function seatCheck(db, day, candidates, settings = DEFAULT_SETTINGS, layout = DEFAULT_LAYOUT) {
  const holding = db
    .prepare(`SELECT * FROM bookings WHERE day = ? AND status IN (${HOLDING.map(() => "?").join(",")})`)
    .all(day, ...HOLDING)
    .filter((h) => !candidates.some((c) => c.id === h.id));
  const rides = [...holding, ...candidates].map((r) => ({ ...r, people: seatPeople(db, r) }));
  return planSeats(timeline(rides, settings), layout);
}

// Check a ride request against the rules and build its rows (and its return trip, if asked), without saving. input:
// { phone, passengerId?, riderName?, men, women, together, pickup: {placeId?|address}, dropoff: {...}, pickupMinute?,
//   window, returnMinute? }
// Returns { ok: true, rides: [...], phone } or { ok: false, errors: [...] }.
export function prepareRide(db, input, now = new Date(), settings = DEFAULT_SETTINGS) {
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
      return row ? { id: row.id, address: row.address, lat: row.lat, lng: row.lng } : null;
    }
    // A one-time address (not saved to the family's places), with its map point when the caller's side found it.
    const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
    const lat = num(p.lat), lng = num(p.lng);
    return String(p.address || "").trim() ? { id: null, address: String(p.address).trim(), lat: lat != null && lng != null ? lat : null, lng: lat != null && lng != null ? lng : null } : null;
  };
  const from = place(input.pickup);
  const to = place(input.dropoff);
  if (!from) errors.push("no_pickup");
  if (!to) errors.push("no_dropoff");
  if (errors.length) return { ok: false, errors };

  let riderName = input.riderName || "";
  let main = null;
  if (input.passengerId) {
    main = db.prepare("SELECT * FROM passengers WHERE id = ? AND active = 1").get(input.passengerId);
    if (!main) return { ok: false, errors: ["unknown_passenger"] };
    riderName = main.name;
  }
  // The people named on the ride (the caller said who is coming): the family, or someone related to it. men and women
  // are everyone, so they must hold at least the named men and women.
  const allowed = new Map(peopleForFamily(db, phone.household_id).map((p) => [p.id, p]));
  const named = [];
  if (Array.isArray(input.riders) && input.riders.length) {
    for (const id of input.riders.map(String)) {
      const p = allowed.get(id) || (main?.id === id ? main : null);
      if (!p) return { ok: false, errors: ["unknown_passenger"] };
      if (!named.some((x) => x.id === id)) named.push(p);
    }
    if (main && !named.some((x) => x.id === main.id)) named.unshift(main);
    const count = (g) => named.filter((p) => p.gender === g).length;
    if (count("m") > men || count("f") > women) return { ok: false, errors: ["riders_count"] };
    if (!input.riderName) riderName = named.map((p) => p.name).join(", ");
  } else if (main) {
    named.push(main);
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
    riders: named.length ? JSON.stringify(named.map((p) => p.id)) : null,
    window_minutes: input.window,
  };
  const rides = [
    { ...base, id: newId("bk"), pickup_place_id: from.id, pickup_address: from.address, pickup_lat: from.lat, pickup_lng: from.lng, dropoff_place_id: to.id, dropoff_address: to.address, dropoff_lat: to.lat, dropoff_lng: to.lng, pickup_minute: check.pickupMinute, return_of: null },
  ];
  if (input.returnMinute != null) {
    rides.push({ ...base, id: newId("bk"), pickup_place_id: to.id, pickup_address: to.address, pickup_lat: to.lat, pickup_lng: to.lng, dropoff_place_id: from.id, dropoff_address: from.address, dropoff_lat: from.lat, dropoff_lng: from.lng, pickup_minute: input.returnMinute, return_of: rides[0].id });
  }

  return { ok: true, rides, phone };
}

// Save prepared rides as pending for the driver.
export function saveRides(db, rides, actor) {
  const insert = db.prepare(`INSERT INTO bookings (id, day, household_id, booked_by_phone, passenger_id, rider_name, men, women,
    together, pickup_place_id, pickup_address, dropoff_place_id, dropoff_address, pickup_minute, window_minutes, return_of,
    status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`);
  const at = nowIso();
  for (const r of rides) {
    insert.run(r.id, r.day, r.household_id, r.booked_by_phone, r.passenger_id, r.rider_name, r.men, r.women, r.together,
      r.pickup_place_id, r.pickup_address, r.dropoff_place_id, r.dropoff_address, r.pickup_minute, r.window_minutes,
      r.return_of, at, at);
    db.prepare("UPDATE bookings SET pickup_lat = ?, pickup_lng = ?, dropoff_lat = ?, dropoff_lng = ?, riders = ? WHERE id = ?").run(
      r.pickup_lat ?? null, r.pickup_lng ?? null, r.dropoff_lat ?? null, r.dropoff_lng ?? null, r.riders ?? null, r.id);
    audit(db, actor, "requested", r.id, { men: r.men, women: r.women, pickup_minute: r.pickup_minute });
  }
  return rides.map((r) => getBooking(db, r.id));
}

// Request a ride with the simple time-line seat check (no map). The phone line and the dashboard use dispatch.js
// bookRide, which plans the real route; this stays for quick checks and tests.
export function requestRide(db, input, now = new Date(), settings = DEFAULT_SETTINGS) {
  const prep = prepareRide(db, input, now, settings);
  if (!prep.ok) return prep;
  const seats = seatCheck(db, prep.rides[0].day, prep.rides, settings);
  if (!seats.ok) return { ok: false, errors: ["no_seats"], detail: seats.reason };
  return { ok: true, bookings: saveRides(db, prep.rides, `phone:${prep.phone.number}`) };
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
export function changeStatus(db, id, action, actor, now = new Date(), settings = DEFAULT_SETTINGS) {
  const t = TRANSITIONS[action];
  const b = getBooking(db, id);
  if (!t || !b) return { ok: false, errors: ["not_found"] };
  if (!t.from.includes(b.status)) return { ok: false, errors: ["wrong_status"], status: b.status };
  db.prepare("UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?").run(t.to, nowIso(), id);
  const minute = localParts(now, settings.timeZone).minute;
  if (action === "pickup") db.prepare("UPDATE bookings SET picked_up_minute = ? WHERE id = ?").run(minute, id);
  if (action === "done") db.prepare("UPDATE bookings SET dropped_off_minute = ?, picked_up_minute = coalesce(picked_up_minute, ?) WHERE id = ?").run(minute, minute, id);
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
