// Relations between people, and who may or may not sit next to whom (set in the dashboard, Families tab).
//
// One row per pair of people: how they are related, and a seat rule:
// - normal: the usual rules (one gender per row, unless the booking said its men and women may sit together).
// - together: this man and woman may share a row, also when they booked separately.
// - apart: these two never share a row, not even on the same booking.
// Rules reach the seating engine (seating.js) on each ride's named riders (people). The phone's "who is coming" list
// is the caller's family plus everyone related to someone in it.
import { audit, newId, nowIso } from "./db.js";

export const KINDS = {
  spouse: "Husband and wife",
  parent: "Parent and child",
  sibling: "Brother and sister",
  grandparent: "Grandparent and grandchild",
  in_law: "In-laws",
  cousin: "Cousins",
  other: "Other relative",
  none: "Not related",
};
export const SEATING = {
  normal: "Usual seating rules",
  together: "May sit next to each other",
  apart: "Must not sit next to each other",
};

export function listRelations(db) {
  return db
    .prepare(`SELECT r.*, a.name AS a_name, a.gender AS a_gender, a.household_id AS a_household, b.name AS b_name,
      b.gender AS b_gender, b.household_id AS b_household FROM relations r
      JOIN passengers a ON a.id = r.a_id JOIN passengers b ON b.id = r.b_id
      WHERE a.active = 1 AND b.active = 1 ORDER BY a.name, b.name`)
    .all()
    .map((r) => ({ ...r, kind_label: KINDS[r.kind] || r.kind, seating_label: SEATING[r.seating] || r.seating }));
}

// Add a relation, or change the one these two people already have. input: { aId, bId, kind, seating, note }
export function setRelation(db, input, actor) {
  const aId = String(input.aId || "");
  const bId = String(input.bId || "");
  const kind = input.kind || "none";
  const seating = input.seating || "normal";
  if (!aId || !bId) return { ok: false, error: "Choose both people." };
  if (aId === bId) return { ok: false, error: "Choose two different people." };
  if (!KINDS[kind]) return { ok: false, error: "Unknown relation." };
  if (!SEATING[seating]) return { ok: false, error: "Unknown seat rule." };
  const get = db.prepare("SELECT * FROM passengers WHERE id = ? AND active = 1");
  const a = get.get(aId);
  const b = get.get(bId);
  if (!a || !b) return { ok: false, error: "Unknown person." };
  if (kind === "none" && seating === "normal") return { ok: false, error: "Choose a relation or a seat rule." };
  const note = String(input.note || "").trim();
  const existing = db.prepare("SELECT * FROM relations WHERE (a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?)").get(aId, bId, bId, aId);
  if (existing) {
    db.prepare("UPDATE relations SET a_id = ?, b_id = ?, kind = ?, seating = ?, note = ? WHERE id = ?").run(aId, bId, kind, seating, note, existing.id);
    audit(db, actor, "relation_changed", null, { id: existing.id, kind, seating });
    return { ok: true, id: existing.id };
  }
  const id = newId("rel");
  db.prepare("INSERT INTO relations (id, a_id, b_id, kind, seating, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, aId, bId, kind, seating, note, actor, nowIso());
  audit(db, actor, "relation_added", null, { id, a: aId, b: bId, kind, seating });
  return { ok: true, id };
}

export function removeRelation(db, id, actor) {
  const r = db.prepare("SELECT * FROM relations WHERE id = ?").get(id);
  if (!r) return { ok: false, error: "Unknown relation." };
  db.prepare("DELETE FROM relations WHERE id = ?").run(id);
  audit(db, actor, "relation_removed", null, { id, a: r.a_id, b: r.b_id });
  return { ok: true };
}

// The named riders of a ride, as the seating engine wants them: [{ id, name, gender, apart: [ids], together: [ids] }].
export function peopleOf(db, ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return [];
  const get = db.prepare("SELECT id, name, gender FROM passengers WHERE id = ?");
  const rules = db.prepare("SELECT * FROM relations WHERE (a_id = ? OR b_id = ?) AND seating != 'normal'");
  return list
    .map((id) => get.get(id))
    .filter(Boolean)
    .map((p) => {
      const rows = rules.all(p.id, p.id);
      const other = (r) => (r.a_id === p.id ? r.b_id : r.a_id);
      return {
        id: p.id,
        name: p.name,
        gender: p.gender,
        apart: rows.filter((r) => r.seating === "apart").map(other),
        together: rows.filter((r) => r.seating === "together").map(other),
      };
    });
}

// A booking row's named riders (bookings.riders, else its one passenger).
export function ridersOf(row) {
  if (row?.riders) {
    try {
      const ids = typeof row.riders === "string" ? JSON.parse(row.riders) : row.riders;
      if (Array.isArray(ids)) return ids;
    } catch {
      // fall through
    }
  }
  return row?.passenger_id ? [row.passenger_id] : [];
}

// Who a phone may name on a ride: everyone in its family, then the people related to someone in it.
export function peopleForFamily(db, householdId) {
  const own = db.prepare("SELECT * FROM passengers WHERE household_id = ? AND active = 1 ORDER BY name").all(householdId);
  const ids = new Set(own.map((p) => p.id));
  const related = db
    .prepare(`SELECT DISTINCT p.* FROM relations r JOIN passengers p ON p.id = CASE WHEN r.a_id IN (SELECT id FROM passengers
      WHERE household_id = ?) THEN r.b_id ELSE r.a_id END
      WHERE (r.a_id IN (SELECT id FROM passengers WHERE household_id = ?) OR r.b_id IN (SELECT id FROM passengers WHERE household_id = ?))
      AND r.kind != 'none' AND p.active = 1 ORDER BY p.name`)
    .all(householdId, householdId, householdId)
    .filter((p) => !ids.has(p.id));
  return [...own, ...related];
}

// A booking row's named riders with their seat rules, only as many of each gender as the ride counts.
export function seatPeople(db, row) {
  const left = { m: row.men || 0, f: row.women || 0 };
  return peopleOf(db, ridersOf(row)).filter((p) => left[p.gender]-- > 0);
}
