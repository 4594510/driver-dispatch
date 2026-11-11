// Saved addresses (places) and their phone codes.
//
// For now every saved address is shared: a code any family saves can be pressed by everyone, so codes are unique
// across all places. (A family's own home is still what key 1 means for that family.) A code is 1 to 6 digits; when
// none is given it is the house number, as long as no other place has it, else the next free number.
import { newId, audit } from "./db.js";
import { normalCode } from "./rules.js";

export const MAX_CODE_DIGITS = 6;
// Pressing 100 at a code means "I'll say a new address", so no place gets it.
export const SAY_CODE = "100";

// code → name of every active place, except one (when editing it).
export function usedCodes(db, exceptId = null) {
  const used = new Map(db.prepare("SELECT code, name FROM places WHERE active = 1 AND id IS NOT ?").all(exceptId).map((p) => [p.code, p.name]));
  used.set(SAY_CODE, "the phone (100 = say a new address)");
  return used;
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

// The code for a new place: the one asked for (refused if taken), else the house number, else the next free one.
// Returns { code } or { error }.
export function chooseCode(db, address, wanted = "") {
  const used = usedCodes(db);
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

// Places a caller can press by code: every active place. When an old code is on two places, the caller's own family's
// comes first, then a shared one.
export function placeByCode(db, code, householdId) {
  return db.prepare(`SELECT * FROM places WHERE active = 1 AND code = ?
    ORDER BY household_id IS NOT ? DESC, household_id IS NULL DESC LIMIT 1`).get(normalCode(code), householdId) || null;
}
export function allPlaces(db) {
  return db.prepare("SELECT * FROM places WHERE active = 1 ORDER BY length(code), code").all();
}

// Save a place. p: { householdId?, code?, kind?, name, address, spoken?, lat?, lng? }. Returns { ok, id, code } or { ok: false, error }.
export function savePlace(db, p, actor) {
  const c = chooseCode(db, p.address, p.code);
  if (c.error) return { ok: false, error: c.error };
  const id = newId("pl");
  db.prepare("INSERT INTO places (id, household_id, code, kind, name, address, spoken, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, p.householdId || null, c.code, p.kind || "other", p.name, p.address, p.spoken || null, p.lat ?? null, p.lng ?? null);
  audit(db, actor, "place_added", null, { id, code: c.code, name: p.name });
  return { ok: true, id, code: c.code };
}
