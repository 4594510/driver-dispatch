// The daily cleanup, right after the daily copy: old rows nobody reads any more are removed so the database stays
// small. Rides, families, places and announcements are never removed.
const DAY = 864e5;
export const KEEP_DAYS = {
  gps: 90,        // driver_locations: the reports' driving time and miles go back this far
  calls: 90,      // phone_calls and sent messages (deliveries)
  actions: 7,     // the driver app's once-only keys
  travel: 30,     // travel times (they are fetched again after 14 days anyway)
  audit: 365,     // the activity log
};

export function cleanupNow(db, now = new Date()) {
  const before = (days) => new Date(now.getTime() - days * DAY).toISOString();
  const run = (sql, ...args) => Number(db.prepare(sql).run(...args).changes);
  return {
    gps: run("DELETE FROM driver_locations WHERE at < ?", before(KEEP_DAYS.gps)),
    calls: run("DELETE FROM phone_calls WHERE updated_at < ?", before(KEEP_DAYS.calls)),
    messages: run("DELETE FROM deliveries WHERE updated_at < ? AND status NOT IN ('queued', 'sending', 'calling')", before(KEEP_DAYS.calls)),
    actions: run("DELETE FROM driver_actions WHERE at < ?", before(KEEP_DAYS.actions)),
    travel: run("DELETE FROM travel_times WHERE at < ?", before(KEEP_DAYS.travel)),
    audit: run("DELETE FROM audit WHERE at < ?", before(KEEP_DAYS.audit)),
    sessions: run("DELETE FROM sessions WHERE expires_at < ?", now.toISOString()) + run("DELETE FROM driver_sessions WHERE expires_at < ?", now.toISOString()),
  };
}
