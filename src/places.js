// Saved addresses (places) and their phone codes.
//
// Every saved address can be used by everyone. A code is 1 to 6 digits; when none is given it is the house number.
// Two places may share a code (Satmer's 1 and a family's home at 1 Main St): a caller pressing it gets their own
// family's place, and otherwise hears the names and presses 1, 2, ... (codeMatches). Only within one family, or among
// the shared places with the same name, is a code kept unique.
import { newId, audit } from "./db.js";
import { normalCode } from "./rules.js";

export const MAX_CODE_DIGITS = 6;
// Pressing 100 at a code means "I'll say a new address", so no place gets it.
export const SAY_CODE = "100";

// code → name of the active places a new place in this family (null = shared) must not repeat: that family's own.
// Shared places don't block each other: callers choose between them.
export function usedCodes(db, householdId = null, exceptId = null) {
  const rows = householdId
    ? db.prepare("SELECT code, name FROM places WHERE active = 1 AND id IS NOT ? AND household_id = ?").all(exceptId, householdId)
    : [];
  const used = new Map(rows.map((p) => [p.code, p.name]));
  used.set(SAY_CODE, "the phone (100 = say a new address)");
  return used;
}
// Other places with this code, for a note ("also used by Walmart").
export function sameCode(db, code, exceptId = null) {
  return db.prepare("SELECT * FROM places WHERE active = 1 AND code = ? AND id IS NOT ?").all(normalCode(code), exceptId);
}

// "12 Main St" → "12"; "Apt 3, 45-B Maple" → "45". None when the address doesn't start with a number.
export function houseNumber(address) {
  const m = /^\s*(\d{1,6})\b/.exec(String(address || ""));
  return m && Number(m[1]) > 0 ? normalCode(m[1]) : null;
}

export function freeCode(used, start = 1) {
  for (let i = start; i < 10 ** MAX_CODE_DIGITS; i++) {
    const c = normalCode(i);
    if (!used.has(c)) return c;
  }
  return null;
}

// The code for a new place: the one asked for, else the house number, else the next free one. Refused only when the
// same family already has it (or it is 100). Returns { code } or { error }.
export function chooseCode(db, address, wanted = "", householdId = null) {
  const used = usedCodes(db, householdId);
  wanted = String(wanted ?? "").trim();
  if (wanted) {
    if (!new RegExp(`^\\d{1,${MAX_CODE_DIGITS}}$`).test(wanted)) return { error: `The code must be 1 to ${MAX_CODE_DIGITS} digits (or leave it empty).` };
    const code = normalCode(wanted);
    if (used.has(code)) return { error: `Code ${code} is already used by ${used.get(code)}. Code ${pickFree(used, address)} is free.` };
    return { code };
  }
  const code = pickFree(used, address);
  return code ? { code } : { error: "All codes are used." };
}
const pickFree = (used, address) => {
  const h = houseNumber(address);
  return h && !used.has(h) ? h : freeCode(used);
};

// The places a caller pressing this code may mean: their own family's place(s) with it if there are any, otherwise
// every place with it. One = take it; more = the caller chooses by name.
export function codeMatches(db, code, householdId) {
  const all = db.prepare("SELECT * FROM places WHERE active = 1 AND code = ? ORDER BY household_id IS NOT NULL, name").all(normalCode(code));
  const own = all.filter((p) => householdId && p.household_id === householdId);
  return own.length ? own : all;
}
export function allPlaces(db) {
  return db.prepare("SELECT * FROM places WHERE active = 1 ORDER BY length(code), code, name").all();
}

// Save a place. p: { householdId?, code?, kind?, name, address, spoken?, lat?, lng? }. Returns { ok, id, code } or { ok: false, error }.
export function savePlace(db, p, actor) {
  const c = chooseCode(db, p.address, p.code, p.householdId || null);
  if (c.error) return { ok: false, error: c.error };
  const id = newId("pl");
  db.prepare("INSERT INTO places (id, household_id, code, kind, name, address, spoken, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, p.householdId || null, c.code, p.kind || "other", p.name, p.address, p.spoken || null, p.lat ?? null, p.lng ?? null);
  audit(db, actor, "place_added", null, { id, code: c.code, name: p.name });
  const others = sameCode(db, c.code, id).map((x) => x.name);
  return { ok: true, id, code: c.code, sharedWith: others };
}
