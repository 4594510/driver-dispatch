// Service rules (spec sections 2, 5, 8, 9): hours, same-day only, pickup windows, the 30-minute driving limit and the
// 30-minute cut-off for changing a pickup address. All times are local to the service area (America/New_York).

export const DEFAULT_SETTINGS = {
  timeZone: "America/New_York",
  openMinute: 10 * 60, // 10:00 AM
  closeMinute: 18 * 60, // 6:00 PM
  maxTripMinutes: 30,
  windows: [15, 30],
  changeCutoffMinutes: 30,
  reminderMinutesBefore: 5,
  reminderRetries: 2,
  driverWaitMinutes: 5,
  stopMinutes: 2, // planned time at each stop to get in or out
  serviceAreas: ["Monsey", "Spring Valley"],
  // Admin settings (Shloime, 2026-11-17). seatRows: the system keeps men and women in their own rows (seating.js);
  // false: seats are only counted (never more than the van holds) and the driver seats people himself.
  seatRows: true,
  // phoneSayPlace: after a place code on the phone, say the place back ("from <place>") before the next question;
  // false: a short "got it" (P95) and on at once, the place said only in the read-back.
  phoneSayPlace: false,
};

// The local calendar date ("2026-11-11") and minute of the day for a moment in time.
export function localParts(date, timeZone = DEFAULT_SETTINGS.timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

// A time typed on the phone keypad as 4 digits ("0230", "1015") into a minute of the day. Hours 10 and 11 are the
// morning; 12 and 1 to 9 are the afternoon (the usual hours are 10 AM to 6 PM). With settings, a time that only fits
// the day's hours one way is read that way (hours from 8 AM: "0830" is the morning).
export function keypadTime(digits, settings = null) {
  if (!/^\d{3,4}$/.test(digits)) return null;
  const d = digits.padStart(4, "0");
  const hour = Number(d.slice(0, 2));
  const minute = Number(d.slice(2));
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const am = (hour % 12) * 60 + minute;
  const pm = am + 12 * 60;
  const usual = hour >= 10 && hour <= 11 ? am : pm;
  if (!settings) return usual;
  const fits = (m) => m >= settings.openMinute && m <= settings.closeMinute;
  if (fits(usual) || (!fits(am) && !fits(pm))) return usual;
  return fits(am) ? am : pm;
}

export function formatMinute(m) {
  const h24 = Math.floor(m / 60);
  const h = ((h24 + 11) % 12) + 1;
  return `${h}:${String(m % 60).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

// Check a ride request. now: Date. req: { day, pickupMinute | null (now), window, returnMinute? }.
// Returns { ok, errors: [code...], pickupMinute }.
export function checkRequest(now, req, settings = DEFAULT_SETTINGS) {
  const errors = [];
  const here = localParts(now, settings.timeZone);
  if (settings.closed) errors.push("closed"); // a schedule change: no rides today (getSettings(db, now))
  if (req.day && req.day !== here.day) errors.push("not_today");
  const pickup = req.pickupMinute ?? here.minute;
  if (!settings.windows.includes(req.window)) errors.push("bad_window");
  if (pickup < settings.openMinute || pickup > settings.closeMinute) errors.push("outside_hours");
  if (req.pickupMinute != null && req.pickupMinute < here.minute) errors.push("in_past");
  // A break the driver planned (settings.breaks, today's): no pickup starts inside it.
  if ((settings.breaks || []).some(([s, e]) => pickup >= s && pickup < e)) errors.push("driver_break");
  if (req.returnMinute != null) {
    if (req.returnMinute < settings.openMinute || req.returnMinute > settings.closeMinute) errors.push("return_outside_hours");
    if (req.returnMinute <= pickup) errors.push("return_before_pickup");
  }
  return { ok: errors.length === 0, errors, pickupMinute: pickup };
}

export function tripTooLong(driveMinutes, settings = DEFAULT_SETTINGS) {
  return driveMinutes > settings.maxTripMinutes;
}

// Passengers may change the pickup address themselves only more than 30 minutes before the pickup window opens.
export function canChangePickup(nowMinute, pickupMinute, settings = DEFAULT_SETTINGS) {
  return pickupMinute - nowMinute > settings.changeCutoffMinutes;
}

// A place's code as saved and as pressed on the phone: 1 to 6 digits, no leading zeros ("01" = "1", "012" = "12").
// Single digits are codes of their own (Shloime, 2026-11-15); 0 alone is home on the phone.
export const normalCode = (keys) => String(Number(keys));
