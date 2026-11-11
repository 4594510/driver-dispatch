import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { setRelation, removeRelation, listRelations, peopleForFamily, peopleOf } from "../src/relations.js";
import { requestRide, acceptBooking } from "../src/bookings.js";

const now = new Date("2026-11-11T16:00:00Z"); // 11:00 AM New York

function setup() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hh1', 'Family A', 'x'), ('hh2', 'Family B', 'x'), ('hh3', 'Family C', 'x')").run();
  const add = db.prepare("INSERT INTO passengers (id, household_id, name, gender) VALUES (?, ?, ?, ?)");
  add.run("moshe", "hh1", "Moshe", "m");
  add.run("rivka", "hh1", "Rivka", "f");
  add.run("yossi", "hh1", "Yossi", "m");
  add.run("bubby", "hh2", "Bubby", "f");
  add.run("other", "hh3", "Stranger", "m");
  db.prepare("INSERT INTO phones (number, household_id, passenger_id) VALUES ('+18455550001', 'hh1', 'moshe')").run();
  db.prepare("INSERT INTO places (id, household_id, code, kind, name, address) VALUES ('home', 'hh1', '01', 'home', 'Home', '1 Example Ln, Monsey')").run();
  db.prepare("INSERT INTO places (id, household_id, code, name, address) VALUES ('shul', NULL, '20', 'Shul', '5 Sample Rd, Spring Valley')").run();
  return db;
}
const ask = (extra = {}) => ({ phone: "+18455550001", men: 1, women: 0, pickup: { placeId: "home" }, dropoff: { placeId: "shul" }, pickupMinute: 12 * 60, window: 15, ...extra });

test("relations are checked, and a second one for the same two people changes the first", () => {
  const db = setup();
  assert.equal(setRelation(db, { aId: "moshe", bId: "moshe", kind: "spouse" }, "t").ok, false);
  assert.equal(setRelation(db, { aId: "moshe", bId: "nobody", kind: "spouse" }, "t").ok, false);
  assert.equal(setRelation(db, { aId: "moshe", bId: "rivka", kind: "friend" }, "t").ok, false);
  assert.equal(setRelation(db, { aId: "moshe", bId: "other", kind: "none", seating: "normal" }, "t").ok, false);
  const r = setRelation(db, { aId: "moshe", bId: "rivka", kind: "spouse", seating: "together" }, "t");
  assert.ok(r.ok);
  const again = setRelation(db, { aId: "rivka", bId: "moshe", kind: "spouse", seating: "normal" }, "t");
  assert.equal(again.id, r.id);
  assert.equal(listRelations(db).length, 1);
  assert.equal(listRelations(db)[0].seating, "normal");
  assert.ok(removeRelation(db, r.id, "t").ok);
  assert.equal(listRelations(db).length, 0);
});

test("seat rules reach each named rider, from either side of the relation", () => {
  const db = setup();
  setRelation(db, { aId: "moshe", bId: "rivka", kind: "spouse", seating: "together" }, "t");
  setRelation(db, { aId: "yossi", bId: "moshe", kind: "none", seating: "apart" }, "t");
  const [m, r] = peopleOf(db, ["moshe", "rivka"]);
  assert.deepEqual(m.together, ["rivka"]);
  assert.deepEqual(m.apart, ["yossi"]);
  assert.deepEqual(r.together, ["moshe"]);
});

test("a phone's people are its family, then their relatives from other families", () => {
  const db = setup();
  setRelation(db, { aId: "bubby", bId: "rivka", kind: "parent", seating: "together" }, "t");
  setRelation(db, { aId: "other", bId: "moshe", kind: "none", seating: "apart" }, "t"); // a seat rule only: not a relative
  assert.deepEqual(peopleForFamily(db, "hh1").map((p) => p.id), ["moshe", "rivka", "yossi", "bubby"]);
});

test("a ride names who is coming; men and women must hold them", () => {
  const db = setup();
  setRelation(db, { aId: "bubby", bId: "rivka", kind: "parent" }, "t");
  assert.deepEqual(requestRide(db, ask({ riders: ["moshe", "rivka"], men: 1, women: 0 }), now).errors, ["riders_count"]);
  assert.deepEqual(requestRide(db, ask({ riders: ["other"] }), now).errors, ["unknown_passenger"]);
  const r = requestRide(db, ask({ passengerId: "moshe", riders: ["bubby"], men: 1, women: 2 }), now);
  assert.ok(r.ok, JSON.stringify(r));
  const b = r.bookings[0];
  assert.deepEqual(JSON.parse(b.riders), ["moshe", "bubby"]);
  assert.equal(b.rider_name, "Moshe, Bubby");
});

test("people who must not sit next to each other are seated in different rows when the driver accepts", () => {
  const db = setup();
  db.prepare("INSERT INTO drivers (id, name, phone) VALUES ('drv1', 'Driver', '+18455550100')").run();
  setRelation(db, { aId: "yossi", bId: "moshe", kind: "sibling", seating: "apart" }, "t");
  const r = requestRide(db, ask({ riders: ["moshe", "yossi"], men: 2 }), now);
  assert.ok(r.ok);
  const a = acceptBooking(db, r.bookings[0].id, "drv1");
  assert.ok(a.ok);
  const seats = JSON.parse(a.booking.seats);
  const row = (id) => Object.keys(seats).find((k) => (seats[k].people || []).includes(id));
  assert.ok(row("moshe") && row("yossi"));
  assert.notEqual(row("moshe"), row("yossi"));
});
