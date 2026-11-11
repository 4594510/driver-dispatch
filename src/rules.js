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
  serviceAreas: ["Monsey", "Spring Valley"],
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
// morning; 12 and 1 to 9 are the afternoon (the service runs 10 AM to 6 PM, so there is no doubt).
export function keypadTime(digits) {
  if (!/^\d{3,4}$/.test(digits)) return null;
  const d = digits.padStart(4, "0");
  let hour = Number(d.slice(0, 2));
  const minute = Number(d.slice(2));
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (hour >= 1 && hour <= 9) hour += 12;
  return hour * 60 + minute;
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
  if (req.day && req.day !== here.day) errors.push("not_today");
  const pickup = req.pickupMinute ?? here.minute;
  if (!settings.windows.includes(req.window)) errors.push("bad_window");
  if (pickup < settings.openMinute || pickup > settings.closeMinute) errors.push("outside_hours");
  if (req.pickupMinute != null && req.pickupMinute < here.minute) errors.push("in_past");
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
