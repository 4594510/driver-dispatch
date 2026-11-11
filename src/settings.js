// Service settings the admin can change (spec section 13: service hours and areas), stored in the settings table
// over the defaults in rules.js.
import { DEFAULT_SETTINGS } from "./rules.js";
import { audit } from "./db.js";

const EDITABLE = {
  openMinute: (v) => Number.isInteger(v) && v >= 0 && v < 24 * 60,
  closeMinute: (v) => Number.isInteger(v) && v > 0 && v <= 24 * 60,
  maxTripMinutes: (v) => Number.isInteger(v) && v >= 5 && v <= 120,
  serviceAreas: (v) => Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === "string" && a.trim()),
  driverWaitMinutes: (v) => Number.isInteger(v) && v >= 0 && v <= 30,
  stopMinutes: (v) => Number.isInteger(v) && v >= 0 && v <= 10,
};

export function getSettings(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'service'").get();
  return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {}) };
}

export function updateSettings(db, changes, by) {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'service'").get();
  const next = stored ? JSON.parse(stored.value) : {};
  for (const [k, v] of Object.entries(changes || {})) {
    if (!EDITABLE[k]) return { ok: false, error: `${k} can't be changed here.` };
    if (!EDITABLE[k](v)) return { ok: false, error: `${k} has a value that doesn't fit.` };
    next[k] = k === "serviceAreas" ? v.map((a) => a.trim()) : v;
  }
  const merged = { ...DEFAULT_SETTINGS, ...next };
  if (merged.openMinute >= merged.closeMinute) return { ok: false, error: "Opening time must be before closing time." };
  db.prepare("INSERT INTO settings (key, value) VALUES ('service', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
  audit(db, by, "settings_changed", null, changes);
  return { ok: true, settings: merged };
}
