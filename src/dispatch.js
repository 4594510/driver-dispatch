// Dispatch (stage 3): ride requests and the driver's answers, checked against the real route of the day.
//
// The route lives in the routes table (stop order, arrival times) and on each booking (seats, pickup and drop-off
// ETAs). Only accepted rides and riders on board are in it; a pending request is checked against it when it comes in
// (so the caller hears right away if there's no room, with the nearest times that fit) and again when the driver
// accepts, with a before/after preview of what the new ride does to everyone else's times.
import { audit, nowIso } from "./db.js";
import { prepareRide, saveRides, getBooking } from "./bookings.js";
import { localParts, DEFAULT_SETTINGS } from "./rules.js";
import { DEFAULT_LAYOUT, seatsByStop } from "./seating.js";
import { pointKey } from "./travel.js";
import { timeRoute, buildRoute, fitRides, seatRoute, etas } from "./route.js";

export const ROUTED = ["accepted", "picked_up"];
const DRIVER_FRESH_MINUTES = 10;
const NEAR_MINUTES = 90; // legs between stops further apart in time than this are never driven back to back

export function vehicleFor(db) {
  const v = db.prepare("SELECT * FROM vehicles ORDER BY rowid LIMIT 1").get();
  return { id: v?.id || "main", layout: v ? JSON.parse(v.layout) : DEFAULT_LAYOUT };
}

// A booking row (or a prepared ride) as the planner sees it.
export function rideOf(row) {
  return {
    id: row.id,
    men: row.men,
    women: row.women,
    together: !!row.together,
    seats: row.seats ? JSON.parse(row.seats) : undefined,
    windowStart: row.pickup_minute,
    windowEnd: row.pickup_minute + row.window_minutes,
    from: pointKey(row.pickup_lat, row.pickup_lng),
    to: pointKey(row.dropoff_lat, row.dropoff_lng),
    onBoard: row.status === "picked_up",
    pickedUpAt: row.picked_up_minute ?? undefined,
  };
}

// Fill in map points for rides (prepared rides or booking rows). A saved place gets its point stored on the place;
// a typed address is cached in geocodes. Booking rows are updated in the database.
export async function locate(db, travel, rides) {
  for (const r of rides) {
    for (const end of ["pickup", "dropoff"]) {
      if (r[`${end}_lat`] != null) continue;
      let point = null;
      const placeId = r[`${end}_place_id`];
      const place = placeId ? db.prepare("SELECT * FROM places WHERE id = ?").get(placeId) : null;
      if (place && place.lat != null && place.address === r[`${end}_address`]) point = { lat: place.lat, lng: place.lng };
      else {
        point = await travel.geocode(r[`${end}_address`]);
        if (point && place && place.address === r[`${end}_address`]) {
          db.prepare("UPDATE places SET lat = ?, lng = ? WHERE id = ?").run(point.lat, point.lng, place.id);
        }
      }
      if (!point) continue;
      r[`${end}_lat`] = point.lat;
      r[`${end}_lng`] = point.lng;
      if (r.created_at) {
        db.prepare(`UPDATE bookings SET ${end}_lat = ?, ${end}_lng = ? WHERE id = ?`).run(point.lat, point.lng, r.id);
      }
    }
  }
}

function routedRows(db, day) {
  return db
    .prepare(`SELECT * FROM bookings WHERE day = ? AND status IN (${ROUTED.map(() => "?").join(",")}) ORDER BY pickup_minute`)
    .all(day, ...ROUTED);
}

function driverPoint(db, now) {
  const d = db.prepare("SELECT * FROM drivers WHERE last_lat IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1").get();
  if (!d?.last_seen_at || now.getTime() - new Date(d.last_seen_at).getTime() > DRIVER_FRESH_MINUTES * 60000) return undefined;
  return pointKey(d.last_lat, d.last_lng) ?? undefined;
}

// Planning context. For today, the route starts now, from the driver's last GPS point when it's fresh (stage 5),
// otherwise as if the driver is at the first stop. Other days start at the first stop's window.
export function contextFor(db, travel, settings, day, now) {
  const here = localParts(now, settings.timeZone);
  const start = day === here.day ? { at: driverPoint(db, now), minute: here.minute } : undefined;
  return {
    minutes: (a, b, m) => travel.minutes(a, b, m),
    stopMinutes: settings.stopMinutes ?? DEFAULT_SETTINGS.stopMinutes,
    maxTrip: settings.maxTripMinutes,
    start,
  };
}

// Ask Google (once, then cached) for the legs a plan for these rides could use.
async function prefetch(db, travel, rides, ctx) {
  const pts = [];
  for (const r of rides) {
    pts.push({ k: r.from, t: r.windowStart });
    pts.push({ k: r.to, t: r.windowEnd + 15 });
  }
  if (ctx.start?.at) pts.push({ k: ctx.start.at, t: ctx.start.minute });
  const legs = [];
  for (const a of pts) {
    for (const b of pts) {
      if (a.k && b.k && a.k !== b.k && Math.abs(a.t - b.t) <= NEAR_MINUTES) legs.push({ a: a.k, b: b.k, minute: a.t });
    }
  }
  await travel.ensure(legs);
}

// The current route for a day: the saved order, without rides that left it, rebuilt when it doesn't cover every ride.
function currentRoute(db, day, rides, ctx, layout) {
  const saved = db.prepare("SELECT stops FROM routes WHERE day = ? AND vehicle_id = ?").get(day, vehicleFor(db).id);
  const byId = new Map(rides.map((r) => [r.id, r]));
  let stops = (saved ? JSON.parse(saved.stops) : [])
    .map((s) => ({ ride: s.booking_id, kind: s.kind }))
    .filter((s) => byId.has(s.ride) && !(s.kind === "pickup" && byId.get(s.ride).onBoard));
  const covered = rides.every((r) => stops.some((s) => s.ride === r.id && s.kind === "dropoff"));
  if (covered) return stops;
  const built = buildRoute(rides, ctx, layout);
  if (built.ok) return built.stops;
  // Over-full data (rides accepted before routing existed): every stop by its time, and the problems are shown.
  stops = [];
  for (const r of rides) {
    if (!r.onBoard) stops.push({ ride: r.id, kind: "pickup", t: r.windowStart });
    stops.push({ ride: r.id, kind: "dropoff", t: r.windowEnd + ctx.maxTrip / 2 });
  }
  return stops.sort((a, b) => a.t - b.t).map(({ ride, kind }) => ({ ride, kind }));
}

// Plan a day with some new rides fitted in. Sync: travel times come from the cache (fetched first by prefetch).
function planDay(db, day, newRides, ctx) {
  const { layout } = vehicleFor(db);
  const rows = routedRows(db, day);
  const rides = rows.map(rideOf).filter((r) => !newRides.some((n) => n.id === r.id));
  const stops = currentRoute(db, day, rides, ctx, layout);
  const before = timeRoute(stops, rides, ctx);
  const after = newRides.length ? fitRides(stops, rides, newRides, ctx, layout) : null;
  return { rides, stops, before, after, layout };
}

function describe(stops, timing) {
  return {
    stops: stops.map((s, i) => ({ booking_id: s.ride, kind: s.kind, arrive: Math.round(timing.times[i].arrive) })),
    driveMinutes: Math.round(timing.drive),
    estimated: timing.estimated,
    late: roundAll(timing.late),
    over: roundAll(timing.over),
  };
}
const roundAll = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));

// How each ride already on the route moves: { id: { pickup: [before, after], dropoff: [before, after] } }, only
// the ones that change by a minute or more.
function shifts(before, beforeStops, after, afterStops) {
  const b = etas(beforeStops, before);
  const a = etas(afterStops, after);
  const out = {};
  for (const [id, e] of Object.entries(b)) {
    for (const kind of ["pickup", "dropoff"]) {
      if (e[kind] == null || a[id]?.[kind] == null) continue;
      if (Math.abs(a[id][kind] - e[kind]) >= 1) (out[id] ||= {})[kind] = [Math.round(e[kind]), Math.round(a[id][kind])];
    }
  }
  return out;
}

function saveRoute(db, day, stops, timing, seats) {
  const v = vehicleFor(db);
  const at = nowIso();
  const rows = stops.map((s, i) => ({ booking_id: s.ride, kind: s.kind, arrive: Math.round(timing.times[i].arrive), depart: Math.round(timing.times[i].depart) }));
  db.prepare(`INSERT INTO routes (day, vehicle_id, stops, drive_minutes, estimated, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, vehicle_id) DO UPDATE SET stops = excluded.stops, drive_minutes = excluded.drive_minutes,
    estimated = excluded.estimated, updated_at = excluded.updated_at`).run(day, v.id, JSON.stringify(rows), Math.round(timing.drive), timing.estimated ? 1 : 0, at);
  const e = etas(stops, timing);
  for (const [id, t] of Object.entries(e)) {
    const sets = ["eta_dropoff_minute = ?", "updated_at = ?"];
    const vals = [t.dropoff != null ? Math.round(t.dropoff) : null, at];
    if (t.pickup != null) {
      sets.push("eta_minute = ?");
      vals.push(Math.round(t.pickup));
    }
    if (seats?.[id]) {
      sets.push("seats = ?");
      vals.push(JSON.stringify(seats[id]));
    }
    db.prepare(`UPDATE bookings SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  }
}

// The nearest pickup times (up to 2) that would fit, 15-minute steps up to 2 hours either way.
function suggestTimes(db, day, prepared, ctx, settings, now) {
  const here = localParts(now, settings.timeZone);
  const first = prepared[0];
  const found = [];
  for (let k = 1; k <= 8 && found.length < 2; k++) {
    for (const off of [k * 15, -k * 15]) {
      const m = first.pickup_minute + off;
      if (m < settings.openMinute || m > settings.closeMinute) continue;
      if (day === here.day && m < here.minute) continue;
      if (prepared[1] && prepared[1].pickup_minute <= m) continue;
      const moved = prepared.map((r, i) => rideOf(i === 0 ? { ...r, pickup_minute: m } : r));
      const plan = planDay(db, day, moved, ctx);
      if (plan.after.ok) found.push(m);
      if (found.length >= 2) break;
    }
  }
  return found.sort((a, b) => a - b);
}

// A ride request from the phone line or the dashboard. Returns { ok, bookings, etas } or
// { ok: false, errors: [not_registered | ... | too_far | no_time | no_seats], suggestions: [minutes] }.
export async function bookRide(db, travel, input, now = new Date(), settings = DEFAULT_SETTINGS, actor = null) {
  const prep = prepareRide(db, input, now, settings);
  if (!prep.ok) return prep;
  await locate(db, travel, prep.rides);
  const day = prep.rides[0].day;
  const ctx = contextFor(db, travel, settings, day, now);
  const newRides = prep.rides.map(rideOf);
  await travel.ensure(newRides.map((r) => ({ a: r.from, b: r.to, minute: r.windowStart })));
  for (const r of newRides) {
    const direct = travel.minutes(r.from, r.to, r.windowStart).minutes;
    if (direct > settings.maxTripMinutes) return { ok: false, errors: ["too_far"], minutes: Math.round(direct) };
  }
  await prefetch(db, travel, [...routedRows(db, day).map(rideOf), ...newRides], ctx);
  const plan = planDay(db, day, newRides, ctx);
  if (!plan.after.ok) {
    return { ok: false, errors: [plan.after.reason], suggestions: suggestTimes(db, day, prep.rides, ctx, settings, now) };
  }
  const saved = saveRides(db, prep.rides, actor || `phone:${prep.phone.number}`);
  const e = etas(plan.after.stops, plan.after.timing);
  return { ok: true, bookings: saved, etas: Object.fromEntries(saved.map((b) => [b.id, Math.round(e[b.id].pickup)])) };
}

async function planWith(db, travel, b, settings, now) {
  await locate(db, travel, [b]);
  const ctx = contextFor(db, travel, settings, b.day, now);
  const ride = rideOf(b);
  await prefetch(db, travel, [...routedRows(db, b.day).map(rideOf), ride], ctx);
  return planDay(db, b.day, [ride], ctx);
}

// What accepting a pending ride would do: the route before and after, and whose times move.
export async function previewAccept(db, travel, id, settings = DEFAULT_SETTINGS, now = new Date()) {
  const b = getBooking(db, id);
  if (!b) return { ok: false, errors: ["not_found"] };
  if (!["pending", "proposed"].includes(b.status)) return { ok: false, errors: ["not_pending"] };
  const p = await planWith(db, travel, b, settings, now);
  const before = describe(p.stops, p.before);
  if (!p.after.ok) return { ok: false, errors: [p.after.reason], before };
  return {
    ok: true,
    before,
    after: describe(p.after.stops, p.after.timing),
    shifts: shifts(p.before, p.stops, p.after.timing, p.after.stops),
    eta: Math.round(etas(p.after.stops, p.after.timing)[id].pickup),
  };
}

// The driver accepts: the ride goes into the route, everyone's seats and ETAs are saved.
export async function acceptRide(db, travel, id, driverId, settings = DEFAULT_SETTINGS, now = new Date()) {
  const b = getBooking(db, id);
  if (!b) return { ok: false, errors: ["not_found"] };
  if (!["pending", "proposed"].includes(b.status)) return { ok: false, errors: ["not_pending"] };
  const p = await planWith(db, travel, b, settings, now);
  if (!p.after.ok) return { ok: false, errors: [p.after.reason] };
  const fresh = getBooking(db, id);
  if (!["pending", "proposed"].includes(fresh.status)) return { ok: false, errors: ["not_pending"] };
  db.prepare("UPDATE bookings SET status = 'accepted', driver_id = ?, updated_at = ? WHERE id = ?").run(driverId, nowIso(), id);
  saveRoute(db, b.day, p.after.stops, p.after.timing, p.after.seats);
  audit(db, `driver:${driverId}`, "accepted", id, { shifts: shifts(p.before, p.stops, p.after.timing, p.after.stops) });
  return { ok: true, booking: getBooking(db, id) };
}

// Re-time the day after a cancel, pickup, drop-off, no-show or address change. Riders on board keep their seats.
export async function refreshDay(db, travel, day, settings = DEFAULT_SETTINGS, now = new Date()) {
  const rows = routedRows(db, day);
  await locate(db, travel, rows);
  const ctx = contextFor(db, travel, settings, day, now);
  const rides = rows.map((r) => rideOf(getBooking(db, r.id)));
  await prefetch(db, travel, rides, ctx);
  const p = planDay(db, day, [], ctx);
  if (!p.rides.length) {
    db.prepare("DELETE FROM routes WHERE day = ? AND vehicle_id = ?").run(day, vehicleFor(db).id);
    return { ok: true, route: null };
  }
  const built = buildRoute(p.rides, ctx, p.layout);
  // Keep the order the driver already has unless rebuilding fixes a problem the current order has.
  const problems = (t) => Object.keys(t.late).length + Object.keys(t.over).length;
  const useBuilt = built.ok && problems(built.timing) < problems(p.before);
  const stops = useBuilt ? built.stops : p.stops;
  const timing = useBuilt ? built.timing : p.before;
  const seats = useBuilt ? { ok: true, plan: built.seats } : seatRoute(stops, p.rides, p.layout);
  saveRoute(db, day, stops, timing, seats.ok ? seats.plan : null);
  return { ok: true, route: describe(stops, timing), seatProblem: !seats.ok };
}

// The saved route for a day, for the dashboard and (stage 5) the driver app.
export function dayRoute(db, day) {
  const v = vehicleFor(db);
  const row = db.prepare("SELECT * FROM routes WHERE day = ? AND vehicle_id = ?").get(day, v.id);
  if (!row) return { day, stops: [], driveMinutes: 0, estimated: false, seatsByStop: [] };
  const stops = JSON.parse(row.stops).map((s) => {
    const b = getBooking(db, s.booking_id);
    return {
      ...s,
      rider_name: b?.rider_name,
      household_id: b?.household_id,
      status: b?.status,
      men: b?.men,
      women: b?.women,
      address: s.kind === "pickup" ? b?.pickup_address : b?.dropoff_address,
      window: s.kind === "pickup" && b ? [b.pickup_minute, b.pickup_minute + b.window_minutes] : null,
      seats: b?.seats ? JSON.parse(b.seats) : null,
    };
  });
  const idx = new Map();
  stops.forEach((s, i) => {
    const cur = idx.get(s.booking_id) || { id: s.booking_id, pickup: -1 };
    cur[s.kind] = i;
    idx.set(s.booking_id, cur);
  });
  const plan = Object.fromEntries(stops.filter((s) => s.seats).map((s) => [s.booking_id, s.seats]));
  const seatRows = [...idx.values()].filter((x) => x.dropoff != null).map((x) => ({ ...x, men: 0, women: 0 }));
  return {
    day,
    stops,
    driveMinutes: row.drive_minutes,
    estimated: !!row.estimated,
    updatedAt: row.updated_at,
    seatsByStop: seatsByStop(seatRows, plan, v.layout).filter((s) => s.stop >= 0),
  };
}
