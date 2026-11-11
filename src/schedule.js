// Schedule changes: the driver (in the app) or an admin (on the dashboard) sets different hours, or no rides at all,
// for one day or a range of days, optionally only on some weekdays ("every Friday until 2 PM"). The usual hours are
// in settings (openMinute, closeMinute). When changes overlap, the newest one counts. Callers hear the hours of today
// and the changes coming up (phone/ivr.js), and booking checks use today's hours (getSettings(db, now)).
import { newId, nowIso, audit } from "./db.js";
import { localParts } from "./rules.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;
export const UPCOMING_DAYS = 14;

const toDate = (day) => new Date(`${day}T12:00:00Z`);
const validDay = (day) => DAY.test(String(day || "")) && toDate(day).toISOString().slice(0, 10) === day;
export const weekdayOf = (day) => toDate(day).getUTCDay(); // 0 Sunday ... 6 Shabbos
export function addDays(day, n) {
  const d = toDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 864e5);

function rowOut(r) {
  return {
    id: r.id, from: r.from_day, to: r.to_day, weekdays: r.weekdays ? JSON.parse(r.weekdays) : null, closed: !!r.closed,
    openMinute: r.open_minute, closeMinute: r.close_minute, note: r.note, createdBy: r.created_by, createdAt: r.created_at,
  };
}

// The hours of one day: { day, closed, openMinute, closeMinute, changed, changeId }.
export function dayHours(db, day, settings) {
  const rows = db
    .prepare("SELECT * FROM schedule_changes WHERE from_day <= ? AND to_day >= ? ORDER BY created_at DESC, rowid DESC")
    .all(day, day);
  const wd = weekdayOf(day);
  const hit = rows.map(rowOut).find((r) => !r.weekdays || r.weekdays.includes(wd));
  if (!hit) return { day, closed: false, openMinute: settings.openMinute, closeMinute: settings.closeMinute, changed: false, changeId: null };
  return {
    day,
    closed: hit.closed,
    openMinute: hit.closed ? null : hit.openMinute,
    closeMinute: hit.closed ? null : hit.closeMinute,
    changed: true,
    changeId: hit.id,
  };
}

// Settings with one day's hours in place: openMinute/closeMinute become that day's, closed is set, and the usual
// hours stay in usualOpenMinute/usualCloseMinute.
export function withDay(db, settings, day) {
  const h = dayHours(db, day, settings);
  return {
    ...settings,
    usualOpenMinute: settings.openMinute,
    usualCloseMinute: settings.closeMinute,
    openMinute: h.closed ? settings.openMinute : h.openMinute,
    closeMinute: h.closed ? settings.closeMinute : h.closeMinute,
    closed: h.closed,
    scheduleChanged: h.changed,
  };
}

// The next days (today first), each with its hours.
export function nextDays(db, settings, now, n = UPCOMING_DAYS) {
  const today = localParts(now, settings.timeZone).day;
  return Array.from({ length: n }, (_, i) => dayHours(db, addDays(today, i), settings));
}

// Changed days after today, with neighbours that have the same hours put together:
// [{ from, to, closed, openMinute, closeMinute }].
export function upcomingChanges(db, settings, now, n = UPCOMING_DAYS) {
  const groups = [];
  for (const d of nextDays(db, settings, now, n).slice(1)) {
    if (!d.changed || (!d.closed && d.openMinute === settings.openMinute && d.closeMinute === settings.closeMinute)) continue;
    const last = groups[groups.length - 1];
    if (last && addDays(last.to, 1) === d.day && last.closed === d.closed && last.openMinute === d.openMinute && last.closeMinute === d.closeMinute) {
      last.to = d.day;
    } else {
      groups.push({ from: d.day, to: d.day, closed: d.closed, openMinute: d.openMinute, closeMinute: d.closeMinute });
    }
  }
  return groups;
}

// Changes that still matter (they end today or later).
export function listChanges(db, settings, now) {
  const today = localParts(now, settings.timeZone).day;
  return db.prepare("SELECT * FROM schedule_changes WHERE to_day >= ? ORDER BY from_day, created_at").all(today).map(rowOut);
}

// Rides already booked on the changed days that fall outside the new hours (they are not cancelled; whoever made the
// change sees them and decides).
function affectedRides(db, change, settings) {
  const rows = db
    .prepare("SELECT * FROM bookings WHERE day >= ? AND day <= ? AND status IN ('pending', 'proposed', 'accepted', 'picked_up') ORDER BY day, pickup_minute")
    .all(change.from, change.to);
  return rows
    .filter((b) => {
      const h = dayHours(db, b.day, settings);
      return h.changeId === change.id && (h.closed || b.pickup_minute < h.openMinute || b.pickup_minute > h.closeMinute);
    })
    .map((b) => ({ id: b.id, day: b.day, rider_name: b.rider_name, pickup_minute: b.pickup_minute, status: b.status, phone: b.booked_by_phone }));
}

// input: { from, to?, closed, openMinute?, closeMinute?, weekdays?, note? }.
export function addChange(db, input, actor, settings, now) {
  const today = localParts(now, settings.timeZone).day;
  const from = String(input?.from || "");
  const to = String(input?.to || from);
  if (!validDay(from) || !validDay(to)) return { ok: false, error: "Choose the dates." };
  if (to < from) return { ok: false, error: "The last day must be on or after the first day." };
  if (to < today) return { ok: false, error: "Those days already passed." };
  if (daysBetween(from, to) > MAX_DAYS) return { ok: false, error: "A change can cover at most about a year." };
  const closed = !!input.closed;
  let open = null;
  let close = null;
  if (!closed) {
    open = Number(input.openMinute);
    close = Number(input.closeMinute);
    if (!Number.isInteger(open) || !Number.isInteger(close) || open < 0 || close > 24 * 60) return { ok: false, error: "Choose the hours." };
    if (open >= close) return { ok: false, error: "The start time must be before the end time." };
  }
  let weekdays = null;
  if (Array.isArray(input.weekdays) && input.weekdays.length && input.weekdays.length < 7) {
    weekdays = [...new Set(input.weekdays.map(Number))].sort();
    if (!weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return { ok: false, error: "Those weekdays don't fit." };
    let any = false;
    for (let d = from; d <= to && !any; d = addDays(d, 1)) any = weekdays.includes(weekdayOf(d));
    if (!any) return { ok: false, error: "None of those weekdays fall in these dates." };
  }
  const note = String(input.note || "").trim().slice(0, 200);
  const row = { id: newId("sch"), from_day: from, to_day: to, weekdays: weekdays ? JSON.stringify(weekdays) : null, closed: closed ? 1 : 0, open_minute: open, close_minute: close, note, created_by: actor, created_at: nowIso() };
  db.prepare(`INSERT INTO schedule_changes (id, from_day, to_day, weekdays, closed, open_minute, close_minute, note, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...Object.values(row));
  const change = rowOut(row);
  audit(db, actor, "schedule_changed", null, { from, to, closed, openMinute: open, closeMinute: close, weekdays, note });
  return { ok: true, change, affected: affectedRides(db, change, settings) };
}

export function removeChange(db, id, actor) {
  const row = db.prepare("SELECT * FROM schedule_changes WHERE id = ?").get(String(id));
  if (!row) return { ok: false, error: "That change is gone." };
  db.prepare("DELETE FROM schedule_changes WHERE id = ?").run(row.id);
  audit(db, actor, "schedule_change_removed", null, rowOut(row));
  return { ok: true };
}

// Everything the dashboard and the app show: the usual hours, the next two weeks day by day, and the changes.
export function scheduleView(db, settings, now) {
  return {
    usual: { openMinute: settings.openMinute, closeMinute: settings.closeMinute },
    days: nextDays(db, settings, now),
    changes: listChanges(db, settings, now),
  };
}
