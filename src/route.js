// Route planning (stage 3): the order of stops for one vehicle's day, with arrival times and seats.
//
// A ride is { id, men, women, together, seats?, windowStart, windowEnd, from, to, onBoard, pickedUpAt?, priority?,
// via?, hasStops? }: via is the stops on the way still to do ([{ id, at }], stops.js), driven right before the drop-off.
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
// A rider already on the route was told a pickup time. Putting a new ride in front of them (two requests for the same
// time: the driver can't be at both places at once) costs this much per minute they are pushed later (twenty times a
// minute of the new rider waiting, twice a minute of driving), so a new ride goes after the ones already promised when
// its window allows.
const PUSH_WEIGHT = 2;

// ctx: { minutes(a, b, departMinute) -> { minutes, estimated }, stopMinutes, maxTrip, start?: { at, minute } }
//
// Riders are not kept waiting in the van (Shloime, 2026-11-20: two pickups close together, drop-offs across town, were
// driven one after the other). When the van, empty, picks someone up and then has to wait at a later pickup for its
// window to open, the driver instead starts that stretch later, as far as the earlier riders' windows allow: they wait
// at home, not on board, so both can be picked up before either is dropped off.
export function timeRoute(stops, rides, ctx) {
  const byId = new Map(rides.map((r) => [r.id, r]));
  const hold = new Map(); // stop index -> the pickup starts no earlier than this
  let timing = timeWith(stops, byId, rides, ctx, hold);
  for (let round = 0; round < stops.length; round++) {
    const h = nextHold(stops, byId, rides, timing);
    if (!h) break;
    hold.set(h.at, timing.times[h.at].arrive + h.by);
    timing = timeWith(stops, byId, rides, ctx, hold);
  }
  return timing;
}

// The first wait on board that starting the stretch later would shorten: { at: the stretch's first stop, by: minutes }.
// A stretch starts at a pickup with nobody in the van (riders already on board can't be held) and runs until it is
// empty again; it can start later by the smallest room left in the windows of its pickups before the wait.
function nextHold(stops, byId, rides, timing) {
  let aboard = rides.filter((r) => r.onBoard && stops.some((s) => s.ride === r.id && s.kind === "dropoff")).length;
  let start = aboard ? -1 : null; // -1: riders on board from the start, nothing to hold
  let room = Infinity;
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    const r = byId.get(s.ride);
    const t = timing.times[i];
    if (s.kind === "pickup") {
      if (aboard === 0) {
        start = i;
        room = Infinity;
      } else if (start >= 0 && t.waited > EPS) {
        const by = Math.min(t.waited, room);
        if (by > 0.5) return { at: start, by };
      }
      room = Math.min(room, Math.max(0, r.windowEnd - t.arrive));
      aboard++;
    } else {
      aboard--;
    }
  }
  return null;
}

function timeWith(stops, byId, rides, ctx, hold) {
  const pickedAt = new Map(rides.filter((r) => r.onBoard).map((r) => [r.id, r.pickedUpAt ?? ctx.start?.minute ?? r.windowStart]));
  let pos = ctx.start?.at ?? undefined; // undefined: the driver starts at the first stop
  let t = ctx.start ? ctx.start.minute : null;
  let drive = 0;
  let estimated = false;
  const late = {};
  const over = {};
  const times = [];
  const go = (at, first) => {
    if (pos === undefined) return t ?? first;
    const leg = ctx.minutes(pos, at, t);
    drive += leg.minutes;
    estimated ||= leg.estimated;
    return t + leg.minutes;
  };
  stops.forEach((s, i) => {
    const r = byId.get(s.ride);
    const at = s.kind === "pickup" ? r.from : r.to;
    // Stops on the way (stops.js): driven in order right before this ride's drop-off, the riders on board.
    let via;
    if (s.kind === "dropoff" && r.via?.length) {
      via = [];
      for (const v of r.via) {
        const a = go(v.at, r.windowStart);
        via.push({ id: v.id, arrive: a, depart: a + ctx.stopMinutes });
        pos = v.at;
        t = a + ctx.stopMinutes;
      }
    }
    const arrive = go(at, r.windowStart);
    let depart;
    if (s.kind === "pickup") {
      const begin = Math.max(arrive, r.windowStart, hold.get(i) ?? -Infinity);
      if (arrive > r.windowEnd + EPS) late[r.id] = arrive - r.windowEnd;
      pickedAt.set(r.id, begin);
      depart = begin + ctx.stopMinutes;
      times.push({ arrive: begin, depart, waited: Math.max(0, r.windowStart - arrive) });
    } else {
      const onBoard = arrive - pickedAt.get(r.id);
      // A ride with stops on the way has no limit on board: the caller asked for the detour.
      if (!r.hasStops && onBoard > ctx.maxTrip + EPS) over[r.id] = onBoard - ctx.maxTrip;
      depart = arrive + ctx.stopMinutes;
      times.push(via ? { arrive, depart, via } : { arrive, depart });
    }
    pos = at;
    t = depart;
  });
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
// people on board than the van has seats. The driver seats them himself. So does the admin's "just count the seats"
// setting (layout.countOnly, from dispatch.js vehicleFor).
export function seatRoute(stops, rides, layout = DEFAULT_LAYOUT) {
  const input = seatInput(stops, rides);
  if (layout.countOnly) return headCount(input, stops.length, layout);
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
// opts.lateOk: the new ride itself may be reached after its window (the driver takes it as it is and the caller hears
// the real time, Shloime 2026-11-16); nobody else may get later. Each late minute counts heavily, so an on-time place
// still wins.
export function insertRide(stops, rides, ride, ctx, layout = DEFAULT_LAYOUT, opts = {}) {
  const all = [...rides.filter((r) => r.id !== ride.id), ride];
  const before = timeRoute(stops, rides, ctx);
  const was = etas(stops, before);
  const allow = { late: opts.lateOk ? { ...before.late, [ride.id]: Infinity } : before.late, over: before.over };
  const candidates = [];
  const n = stops.length;
  for (let i = 0; i <= n; i++) {
    for (let j = i; j <= n; j++) {
      const next = [...stops.slice(0, i), { ride: ride.id, kind: "pickup" }, ...stops.slice(i, j), { ride: ride.id, kind: "dropoff" }, ...stops.slice(j)];
      const timing = timeRoute(next, all, ctx);
      if (!withinAllowance(timing, allow)) continue;
      candidates.push({ stops: next, timing, cost: cost(timing, next, all) + 10 * (timing.late[ride.id] || 0) + PUSH_WEIGHT * pushed(was, next, timing) });
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

// Minutes the pickups already on the route move later on a new timing (the ones on board have no pickup left).
function pushed(was, stops, timing) {
  let m = 0;
  stops.forEach((s, i) => {
    if (s.kind === "pickup" && was[s.ride]?.pickup != null) m += Math.max(0, timing.times[i].arrive - was[s.ride].pickup);
  });
  return m;
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
// opts.lateOk: see insertRide.
export function fitRides(stops, rides, newRides, ctx, layout = DEFAULT_LAYOUT, opts = {}) {
  const ids = new Set(rides.map((r) => r.id));
  let cur = stops.filter((s) => ids.has(s.ride));
  let placed = [...rides];
  let firstFail = null;
  for (const r of newRides) {
    const res = insertRide(cur, placed, r, ctx, layout, opts);
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
