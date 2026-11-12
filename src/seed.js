// Lists of shared places Shloime gave, added once to the live database at startup (each list by its key, so a place
// an admin removes later doesn't come back). A code another place also has is shared: callers choose by name.
import { audit } from "./db.js";
import { savePlace } from "./places.js";
import { normalCode } from "./rules.js";

// 2026-11-11: "the address is the code". Addresses as Google Maps found them.
export const PLACE_LISTS = {
  "places-2026-11-11": [
    ["1", "Satmer", "1 Monsey Blvd, Monsey, NY 10952"],
    ["6", "Schnabolg", "6 Gibbs Ct, Monsey, NY 10952"],
    ["7", "Mnachem Yisral", "7 Ronald Dr, Monsey, NY 10952"],
    ["18", "Mottys Supermarket", "18 College Rd, Monsey, NY 10952"],
    ["20", "G&G Quality Clothing", "20 Robert Pitt Dr, Monsey, NY 10952"],
    ["25", "Viznitz", "25 Phyllis Terrace, Monsey, NY 10952", 41.1187424, -74.0668183],
    ["27", "Shoppers Haven Mall", "27 Orchard St, Monsey, NY 10952"],
    ["30", "Rubin", "30 Forshay Rd, Monsey, NY 10952"],
    ["40", "Weinberger", "40 Forshay Rd, Monsey, NY 10952"],
    ["45", "Moshe Shemiel", "45 Forshay Rd, Monsey, NY 10952"],
    ["47", "Rabbi", "47 Forshay Rd, Monsey, NY 10952"],
    ["49", "Shul", "49 Forshay Rd, Monsey, NY 10952"],
    ["59", "Town Square Mall", "59 Route 59, Monsey, NY 10952"],
    ["108", "Taub", "108 Route 306, Monsey, NY 10952"],
    ["382", "Yshay Dovid", "382 Blauvelt Rd, Monsey, NY 10952"],
    ["401", "Atrium", "401 Route 59, Monsey, NY 10952", 41.1070945, -74.0609511],
  ],
  // Viznitz and Weinberger were skipped on 2026-11-11 (Walmart and Dr lebowitz had 25 and 40); codes may be shared now.
  "places-2026-11-12": [
    ["25", "Viznitz", "25 Phyllis Terrace, Monsey, NY 10952", 41.1187424, -74.0668183],
    ["40", "Weinberger", "40 Forshay Rd, Monsey, NY 10952"],
  ],
};

export function addPlaceLists(db, lists = PLACE_LISTS, log = console.log) {
  for (const [key, list] of Object.entries(lists)) {
    const flag = `seed:${key}`;
    if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(flag)) continue;
    let added = 0;
    for (const [code, name, address, lat, lng] of list) {
      if (db.prepare("SELECT 1 FROM places WHERE active = 1 AND code = ? AND name = ?").get(normalCode(code), name)) continue;
      const r = savePlace(db, { code, name, address, kind: "other", lat, lng }, "system:list");
      if (r.ok) added++;
      if (r.sharedWith?.length) log(`places list ${key}: code ${r.code} is shared by ${name} and ${r.sharedWith.join(", ")}`);
    }
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(flag, JSON.stringify({ at: new Date().toISOString(), added }));
    audit(db, "system:list", "places_list_added", null, { key, added });
    log(`places list ${key}: ${added} added`);
  }
  undoCodeMoves(db, log);
  fixCodes(db, CODE_FIXES, log);
}

// Codes Shloime corrected (2026-11-12): Walmart and Dr Lebowitz were saved as 25 and 40 before codes could have 3
// digits; they are 250 and 400. A place found only removed is brought back (Walmart was missing from the list).
export const CODE_FIXES = {
  "codes-2026-11-12": [["walmart", "250"], ["dr lebowitz", "400"]],
};
export function fixCodes(db, fixes = CODE_FIXES, log = console.log) {
  for (const [key, list] of Object.entries(fixes)) {
    const flag = `seed:${key}`;
    if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(flag)) continue;
    const done = [];
    for (const [name, code] of list) {
      const p = db.prepare("SELECT * FROM places WHERE lower(trim(name)) = ? ORDER BY active DESC, rowid DESC LIMIT 1").get(name);
      if (!p) { log(`codes ${key}: no place named ${name}`); continue; }
      db.prepare("UPDATE places SET code = ?, active = 1 WHERE id = ?").run(code, p.id);
      audit(db, "system:list", "place_code_changed", null, { id: p.id, from: p.code, to: code, ...(p.active ? {} : { restored: true }) });
      log(`codes ${key}: ${p.name} ${p.code} -> ${code}${p.active ? "" : " (was removed, brought back)"}`);
      done.push(p.name);
    }
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(flag, JSON.stringify({ at: new Date().toISOString(), done }));
  }
}

// 2026-11-11 the first list moved family places out of its codes (codes were unique then). Codes may now be shared,
// so those places get their old codes back, once, unless someone changed them since.
function undoCodeMoves(db, log) {
  const flag = "seed:undo-moves-2026-11-12";
  if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(flag)) return;
  let n = 0;
  for (const a of db.prepare("SELECT details FROM audit WHERE actor = 'system:list' AND action = 'place_code_changed'").all()) {
    const d = JSON.parse(a.details || "{}");
    const r = db.prepare("UPDATE places SET code = ? WHERE id = ? AND code = ?").run(d.from, d.id, d.to);
    if (r.changes) {
      n++;
      audit(db, "system:list", "place_code_changed", null, { id: d.id, from: d.to, to: d.from, undo: true });
      log(`places: ${d.id} back to code ${d.from}`);
    }
  }
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(flag, JSON.stringify({ at: new Date().toISOString(), restored: n }));
}
