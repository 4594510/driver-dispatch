// Route planning (stage 3): the order of stops for one vehicle's day, with arrival times and seats.
//
// A ride is { id, men, women, together, seats?, windowStart, windowEnd, from, to, onBoard, pickedUpAt?, priority? }:
// from/to are point keys (travel.js), the window is the promised pickup window in minutes after midnight, onBoard
// means the driver already picked them up (only the drop-off is left, and their seats can't change). priority is the
// admin's level for the rider (0 normal, 1 high, 2 top; priority.js): their waiting counts more when choosing an order.
//
// A route is a list of stops [{ ride, kind: "pickup" | "dropoff" }]. Timing walks the stops: the driver waits at a
// pickup until its window opens; a pickup reached after its window closes is late; a rider on board longer than the
// trip limit (30 minutes) is over. Seats are then checked across the whole route by seating.js.
//
// New rides are inserted into the existing order at the best place (the classic dial-a-ride insertion), so people
// already promised a time keep it: an insertion may not make anyone later or longer on board than they already were.
// When no insertion fits, the whole day is rebuilt once from scratch in pickup-time order, which sometimes finds room.
import { planSeats, DEFAULT_LAYOUT, capacity } from "./seating.js";

const EPS = 0.01;

// ctx: { minutes(a, b, departMinute) -> { minutes, estimated }, stopMinutes, maxTrip, start?: { at, minute } }
export function timeRoute(stops, rides, ctx) {
  const byId = new Map(rides.map((r) => [r.id, r]));
  const pickedAt = new Map(rides.filter((r) => r.onBoard).map((r) => [r.id, r.pickedUpAt ?? ctx.start?.minute ?? r.windowStart]));
  let pos = ctx.start?.at ?? undefined; // undefined: the driver starts at the first stop
  let t = ctx.start ? ctx.start.minute : null;
  let drive = 0;
  let estimated = false;
  const late = {};
  const over = {};
  const times = [];
  for (const s of stops) {
    const r = byId.get(s.ride);
    const at = s.kind === "pickup" ? r.from : r.to;
    let arrive;
    if (pos === undefined) arrive = t ?? r.windowStart;
    else {
      const leg = ctx.minutes(pos, at, t);
      drive += leg.minutes;
      estimated ||= leg.estimated;
      arrive = t + leg.minutes;
    }
    let depart;
    if (s.kind === "pickup") {
      const begin = Math.max(arrive, r.windowStart);
      if (arrive > r.windowEnd + EPS) late[r.id] = arrive - r.windowEnd;
      pickedAt.set(r.id, begin);
      depart = begin + ctx.stopMinutes;
      times.push({ arrive: begin, depart });
    } else {
      const onBoard = arrive - pickedAt.get(r.id);
      if (onBoard > ctx.maxTrip + EPS) over[r.id] = onBoard - ctx.maxTrip;
      depart = arrive + ctx.stopMinutes;
      times.push({ arrive, depart });
    }
    pos = at;
    t = depart;
  }
  return { times, drive, estimated, late, over, end: t };
}

// Stop indexes for the seating engine. Riders already on board sit from before the first stop (-1).
function seatInput(stops, rides) {
  const idx = new Map();
  stops.forEach((s, i) => {
    const cur = idx.get(s.ride) || {};
    cur[s.kind] = i;
    idx.set(s.ride, cur);
  });
  return rides
    .filter((r) => idx.has(r.id))
    .map((r) => ({
      id: r.id,
      men: r.men,
      women: r.women,
      together: !!r.together,
      people: r.people || [],
      seats: r.seats || undefined,
      pickup: r.onBoard ? -1 : idx.get(r.id).pickup,
      dropoff: idx.get(r.id).dropoff,
    }));
}

// Seats for a route. Riders on board keep their seats exactly; everyone else may be moved before pickup.
// A ride the driver took against the seat rules (seatOverride) makes the check count heads only: at no point more
// people on board than the van has seats. The driver seats them himself.
export function seatRoute(stops, rides, layout = DEFAULT_LAYOUT) {
  const input = seatInput(stops, rides);
  if (rides.some((r) => r.seatOverride && input.some((x) => x.id === r.id))) return headCount(input, stops.length, layout);
  const res = planSeats(input, layout);
  if (!res.ok) return res;
  for (const r of rides) {
    if (!r.onBoard || !r.seats) continue;
    if (JSON.stringify(countRows(res.plan[r.id])) !== JSON.stringify(countRows(r.seats))) return { ok: false, reason: "no_seating" };
  }
  return res;
}
function headCount(input, n, layout) {
  const cap = capacity(layout);
  for (let i = -1; i < n; i++) {
    const heads = input.filter((b) => b.pickup <= i && i < b.dropoff).reduce((t, b) => t + b.men + b.women, 0);
    if (heads > cap) return { ok: false, reason: "full" };
  }
  return { ok: true, plan: {}, countOnly: true };
}
// Men and women per row (who exactly sits where may have been worked out before a seat rule was added).
const countRows = (p) => Object.fromEntries(Object.entries(p || {}).sort().map(([k, v]) => [k, { men: v.men, women: v.women }]));

// Does a timing stay within what was allowed? allow: { late: {id: minutes}, over: {id: minutes} } from before.
function withinAllowance(timing, allow) {
  for (const [id, m] of Object.entries(timing.late)) if (m > (allow.late[id] || 0) + EPS) return false;
  for (const [id, m] of Object.entries(timing.over)) if (m > (allow.over[id] || 0) + EPS) return false;
  return true;
}

// Lower is better: driving time, plus a little for every minute a pickup is later than its window opens. A minute of
// waiting counts double for a high-priority rider and triple for top priority.
function cost(timing, stops, rides) {
  const byId = new Map(rides.map((r) => [r.id, r]));
  let waitPast = 0;
  stops.forEach((s, i) => {
    if (s.kind !== "pickup") return;
    const r = byId.get(s.ride);
    waitPast += (timing.times[i].arrive - r.windowStart) * (1 + (r.priority || 0));
  });
  return timing.drive + 0.1 * waitPast;
}

// Insert one ride into a route. Returns { ok, stops, timing, seats } or { ok: false, reason: "no_time" | "no_seats" }.
export function insertRide(stops, rides, ride, ctx, layout = DEFAULT_LAYOUT) {
  const all = [...rides.filter((r) => r.id !== ride.id), ride];
  const before = timeRoute(stops, rides, ctx);
  const allow = { late: before.late, over: before.over };
  const candidates = [];
  const n = stops.length;
  for (let i = 0; i <= n; i++) {
    for (let j = i; j <= n; j++) {
      const next = [...stops.slice(0, i), { ride: ride.id, kind: "pickup" }, ...stops.slice(i, j), { ride: ride.id, kind: "dropoff" }, ...stops.slice(j)];
      const timing = timeRoute(next, all, ctx);
      if (!withinAllowance(timing, allow)) continue;
      candidates.push({ stops: next, timing, cost: cost(timing, next, all) });
    }
  }
  if (!candidates.length) return { ok: false, reason: "no_time" };
  candidates.sort((a, b) => a.cost - b.cost);
  for (const c of candidates) {
    const seats = seatRoute(c.stops, all, layout);
    if (seats.ok) return { ok: true, stops: c.stops, timing: c.timing, seats: seats.plan };
  }
  return { ok: false, reason: "no_seats" };
}

// Build a day's route from nothing: riders on board first (their drop-offs), then everyone else in pickup-time order
// (higher priority first among the same pickup time, so they get the better places).
export function buildRoute(rides, ctx, layout = DEFAULT_LAYOUT) {
  let stops = [];
  const placed = [];
  const order = [...rides].sort((a, b) => (b.onBoard ? 1 : 0) - (a.onBoard ? 1 : 0) || a.windowStart - b.windowStart || (b.priority || 0) - (a.priority || 0));
  for (const r of order) {
    if (r.onBoard) {
      // Drop-offs of riders on board: insert only the drop-off, at the best place.
      const all = [...placed, r];
      let best = null;
      for (let j = 0; j <= stops.length; j++) {
        const next = [...stops.slice(0, j), { ride: r.id, kind: "dropoff" }, ...stops.slice(j)];
        const timing = timeRoute(next, all, ctx);
        const c = cost(timing, next, all) + 1000 * (Object.keys(timing.late).length + Object.keys(timing.over).length);
        if (!best || c < best.c) best = { next, c };
      }
      stops = best.next;
      placed.push(r);
      continue;
    }
    const res = insertRide(stops, placed, r, ctx, layout);
    if (!res.ok) return { ok: false, reason: res.reason, ride: r.id };
    stops = res.stops;
    placed.push(r);
  }
  const timing = timeRoute(stops, rides, ctx);
  const seats = seatRoute(stops, rides, layout);
  if (!seats.ok) return { ok: false, reason: "no_seats" };
  return { ok: true, stops, timing, seats: seats.plan };
}

// Fit new rides into a day: first into the existing order, else by rebuilding the whole day.
// rides: the rides already in the route; stops: their current order (stops of rides not in `rides` are dropped).
export function fitRides(stops, rides, newRides, ctx, layout = DEFAULT_LAYOUT) {
  const ids = new Set(rides.map((r) => r.id));
  let cur = stops.filter((s) => ids.has(s.ride));
  let placed = [...rides];
  let firstFail = null;
  for (const r of newRides) {
    const res = insertRide(cur, placed, r, ctx, layout);
    if (!res.ok) {
      firstFail = res.reason;
      break;
    }
    cur = res.stops;
    placed.push(r);
  }
  if (!firstFail) {
    const timing = timeRoute(cur, placed, ctx);
    const seats = seatRoute(cur, placed, layout);
    if (seats.ok) return { ok: true, stops: cur, timing, seats: seats.plan };
  }
  // Rebuild, but only accept it if nobody already promised ends up later or longer on board than before.
  const all = [...rides, ...newRides];
  const rebuilt = buildRoute(all, ctx, layout);
  if (rebuilt.ok) {
    const before = timeRoute(stops.filter((s) => ids.has(s.ride)), rides, ctx);
    if (withinAllowance(rebuilt.timing, { late: before.late, over: before.over })) return rebuilt;
  }
  return { ok: false, reason: firstFail || rebuilt.reason || "no_time" };
}

// Arrival time of each ride's pickup and drop-off on a timed route.
export function etas(stops, timing) {
  const out = {};
  stops.forEach((s, i) => {
    out[s.ride] ||= {};
    out[s.ride][s.kind] = timing.times[i].arrive;
  });
  return out;
}
