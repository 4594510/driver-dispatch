// A time typed in a plain field (Shloime, 2026-11-17: "a regular free field to enter time" instead of a list every 5
// minutes): "2:35", "235", "2.35", "14:35", "2:35 pm", "10 am". Without AM or PM, 7 to 11 is the morning and 12 to 6
// the afternoon (the service runs in the day). Returns the minute of the day, or null when it isn't a time.
// Loaded as a plain script by the driver app and the dashboard, and imported by the tests.
globalThis.parseTimeText = function parseTimeText(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const m = /^(\d{1,2})(?:[:.\s]?(\d{2}))?\s*(a|am|a\.m\.|p|pm|p\.m\.)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] == null ? 0 : Number(m[2]);
  if (min > 59) return null;
  const half = m[3] ? m[3][0] : null;
  if (half) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (half === "p" ? 12 : 0);
  } else if (h > 23) return null;
  else if (h >= 1 && h <= 6) h += 12;
  else if (h === 0 && m[2] == null) return null;
  return h * 60 + min;
};
