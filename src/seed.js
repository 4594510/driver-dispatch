// Lists of shared places Shloime gave, added once to the live database at startup (each list by its key, so a place
// an admin removes later doesn't come back). When one family's own place has a code from the list, that place moves to
// its house number or the next free code (key 1 still means home); a code a shared place has is skipped. Both are logged.
import { audit } from "./db.js";
import { usedCodes, savePlace, houseNumber, freeCode } from "./places.js";
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
};

export function addPlaceLists(db, lists = PLACE_LISTS, log = console.log) {
  for (const [key, list] of Object.entries(lists)) {
    const flag = `seed:${key}`;
    if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(flag)) continue;
    const wanted = new Set(list.map(([code]) => normalCode(code)));
    for (const p of db.prepare("SELECT * FROM places WHERE active = 1 AND household_id IS NOT NULL").all()) {
      if (!wanted.has(p.code)) continue;
      const used = usedCodes(db);
      for (const c of wanted) used.set(c, "list");
      const h = houseNumber(p.address);
      const code = h && !used.has(h) ? h : freeCode(used);
      db.prepare("UPDATE places SET code = ? WHERE id = ?").run(code, p.id);
      audit(db, "system:list", "place_code_changed", null, { id: p.id, from: p.code, to: code });
      log(`places list ${key}: ${p.name} moved from code ${p.code} to ${code}`);
    }
    const used = usedCodes(db);
    let added = 0;
    for (const [code, name, address, lat, lng] of list) {
      const c = normalCode(code);
      if (used.has(c)) { log(`places list ${key}: code ${c} is already used by ${used.get(c)}, ${name} skipped`); continue; }
      if (savePlace(db, { code, name, address, kind: "other", lat, lng }, "system:list").ok) added++;
    }
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(flag, JSON.stringify({ at: new Date().toISOString(), added }));
    audit(db, "system:list", "places_list_added", null, { key, added });
    log(`places list ${key}: ${added} added`);
  }
}
