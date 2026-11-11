// Reports (spec section 14) for a range of days. Waiting time and on-time pickups come from the times the driver marked
// in the app; driving time and miles from the app's GPS points.

const ACCEPTED_EVER = ["accepted", "picked_up", "completed", "no_show"];
const MAX_GAP_MS = 5 * 60000;   // a gap longer than this (no signal, phone off) isn't counted as driving
const MOVING_MPH = 3;           // slower than this between two points counts as standing
const MAX_MPH = 90;             // faster than this is a bad GPS jump

// Miles between two points.
export function miles(a, b) {
  const R = 3958.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Driving minutes and miles from GPS points sorted by time.
export function driving(points) {
  let mi = 0;
  let ms = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dt = new Date(b.at) - new Date(a.at);
    if (dt <= 0 || dt > MAX_GAP_MS) continue;
    const d = miles(a, b);
    const mph = d / (dt / 3600000);
    if (mph > MAX_MPH || mph < MOVING_MPH) continue;
    mi += d;
    ms += dt;
  }
  return { minutes: Math.round(ms / 60000), miles: Math.round(mi * 10) / 10 };
}

// The local day of an ISO time (the GPS points are stored in UTC).
function localDay(iso, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export function report(db, fromDay, toDay, timeZone = "America/New_York") {
  const rows = db.prepare("SELECT * FROM bookings WHERE day BETWEEN ? AND ?").all(fromDay, toDay);
  const count = (pred) => rows.filter(pred).length;
  const auditRows = db
    .prepare("SELECT action, actor FROM audit WHERE substr(at, 1, 10) BETWEEN ? AND ?")
    .all(fromDay, toDay);
  const driverActivity = {};
  for (const a of auditRows) {
    if (!a.actor.startsWith("driver:")) continue;
    driverActivity[a.action] = (driverActivity[a.action] || 0) + 1;
  }
  // Waiting: from the start of the promised window to the pickup the driver marked (0 when on time or early).
  const picked = rows.filter((b) => b.picked_up_minute != null && ["picked_up", "completed"].includes(b.status));
  const waits = picked.map((b) => Math.max(0, b.picked_up_minute - b.pickup_minute));
  const onTime = picked.filter((b) => b.picked_up_minute <= b.pickup_minute + b.window_minutes).length;
  const rideMinutes = rows
    .filter((b) => b.dropped_off_minute != null && b.picked_up_minute != null)
    .map((b) => b.dropped_off_minute - b.picked_up_minute);
  // GPS: a day's points start a little before midnight UTC of that day.
  const from = new Date(new Date(`${fromDay}T00:00:00Z`).getTime() - 864e5).toISOString();
  const to = new Date(new Date(`${toDay}T00:00:00Z`).getTime() + 2 * 864e5).toISOString();
  const pts = db.prepare("SELECT driver_id, at, lat, lng FROM driver_locations WHERE at BETWEEN ? AND ? ORDER BY driver_id, at").all(from, to);
  const byDriverDay = new Map();
  for (const p of pts) {
    const d = localDay(p.at, timeZone);
    if (d < fromDay || d > toDay) continue;
    const k = `${p.driver_id}|${d}`;
    if (!byDriverDay.has(k)) byDriverDay.set(k, []);
    byDriverDay.get(k).push(p);
  }
  let drivingMinutes = 0;
  let mi = 0;
  for (const list of byDriverDay.values()) {
    const d = driving(list);
    drivingMinutes += d.minutes;
    mi += d.miles;
  }
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  return {
    from: fromDay,
    to: toDay,
    requested: rows.length,
    accepted: count((b) => ACCEPTED_EVER.includes(b.status) || (b.status === "cancelled" && b.seats)),
    rejected: count((b) => b.status === "rejected"),
    completed: count((b) => b.status === "completed"),
    cancelled: count((b) => b.status === "cancelled"),
    noShows: count((b) => b.status === "no_show"),
    pending: count((b) => b.status === "pending" || b.status === "proposed"),
    passengersTransported: rows.filter((b) => b.status === "completed").reduce((n, b) => n + b.men + b.women, 0),
    timeChanges: auditRows.filter((a) => a.action === "proposed_time").length,
    averageWaitMinutes: avg(waits),
    onTimePickups: picked.length ? { onTime, of: picked.length } : null,
    averageRideMinutes: avg(rideMinutes),
    drivingMinutes: pts.length ? drivingMinutes : null,
    miles: pts.length ? Math.round(mi * 10) / 10 : null,
    driverActivity,
  };
}
