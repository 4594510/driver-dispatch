// Reports (spec section 14) for a range of days. Waiting time, driving time and mileage need the driver app's GPS and
// pickup times (stage 5), so until then they come back as null.

const ACCEPTED_EVER = ["accepted", "picked_up", "completed", "no_show"];

export function report(db, fromDay, toDay) {
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
    averageWaitMinutes: null,
    drivingMinutes: null,
    miles: null,
    driverActivity,
  };
}
