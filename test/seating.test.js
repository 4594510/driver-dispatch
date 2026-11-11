import test from "node:test";
import assert from "node:assert/strict";
import { planSeats, seatsByStop } from "../src/seating.js";

const ride = (id, men, women, extra = {}) => ({ id, men, women, together: false, pickup: 0, dropoff: 1, ...extra });

test("one man fits, and gets the front seat or a row", () => {
  const r = planSeats([ride("a", 1, 0)]);
  assert.ok(r.ok);
  assert.equal(Object.values(r.plan.a).reduce((n, s) => n + s.men, 0), 1);
});

test("2 men and 2 women who must sit apart get separate rows", () => {
  const r = planSeats([ride("a", 2, 2)]);
  assert.ok(r.ok);
  for (const s of Object.values(r.plan.a)) assert.ok(s.men === 0 || s.women === 0);
});

test("women never sit in the front seat; 7 women do not fit", () => {
  assert.equal(planSeats([ride("a", 0, 7)]).ok, false);
  const r = planSeats([ride("a", 0, 6)]);
  assert.ok(r.ok);
  assert.equal(r.plan.a.front, undefined);
});

test("a row stays one gender: 5 women and 2 men from different bookings do not fit", () => {
  assert.equal(planSeats([ride("a", 0, 3), ride("b", 2, 2)]).ok, false);
});

test("a family that may sit together can share a row, so the same people then fit", () => {
  const r = planSeats([ride("a", 0, 3), ride("b", 2, 2, { together: true })]);
  assert.ok(r.ok);
  const mixed = Object.values(r.plan.b).find((s) => s.men > 0 && s.women > 0);
  assert.ok(mixed, "b uses a mixed row");
});

test("a mixed row never takes anyone from another booking", () => {
  // b (1 man + 1 woman, together) and c (2 men): front takes 1 man, the rest need rows without mixing strangers in.
  const r = planSeats([ride("b", 1, 1, { together: true }), ride("c", 2, 0), ride("d", 0, 2)]);
  assert.ok(r.ok);
  const rows = ["front", "row2", "row3"];
  for (const row of rows) {
    const inRow = Object.entries(r.plan).filter(([, s]) => s[row]);
    const men = inRow.reduce((n, [, s]) => n + s[row].men, 0);
    const women = inRow.reduce((n, [, s]) => n + s[row].women, 0);
    if (men > 0 && women > 0) assert.deepEqual(inRow.map(([id]) => id), ["b"]);
  }
});

test("seats free up after a drop-off: rides one after another do not clash", () => {
  const r = planSeats([ride("a", 0, 6, { pickup: 0, dropoff: 1 }), ride("b", 7, 0, { pickup: 1, dropoff: 2 })]);
  assert.ok(r.ok);
});

test("over capacity is caught at the stop where it happens", () => {
  const r = planSeats([ride("a", 4, 0, { pickup: 0, dropoff: 3 }), ride("b", 4, 0, { pickup: 1, dropoff: 2 })]);
  assert.deepEqual(r, { ok: false, reason: "over_capacity", at: 1 });
});

test("riders already seated keep their seats when someone new is added", () => {
  const first = planSeats([ride("a", 0, 2)]);
  const seats = first.plan.a;
  const again = planSeats([ride("a", 0, 2, { seats }), ride("b", 3, 0)]);
  assert.ok(again.ok);
  assert.deepEqual(again.plan.a, seats);
});

test("seatsByStop counts taken and free seats in every row", () => {
  const rides = [ride("a", 1, 0, { pickup: 0, dropoff: 2 }), ride("b", 0, 3, { pickup: 1, dropoff: 2 })];
  const r = planSeats(rides);
  const stops = seatsByStop(rides, r.plan);
  const total = (s) => s.rows.reduce((n, x) => n + x.men + x.women, 0);
  assert.deepEqual(stops.map(total), [1, 4, 0]);
});

// Seat rules between named people (relations.js).
const man = (id, rules = {}) => ({ id, gender: "m", apart: [], together: [], ...rules });
const woman = (id, rules = {}) => ({ id, gender: "f", apart: [], together: [], ...rules });
const rowOf = (plan, id) => Object.entries(plan).flatMap(([, rows]) => Object.entries(rows)).find(([, s]) => (s.people || []).includes(id))?.[0];

test("two people who must not sit next to each other get different rows, even on one ride", () => {
  const r = planSeats([ride("a", 3, 0, { people: [man("A", { apart: ["B"] }), man("B")] })]);
  assert.ok(r.ok);
  assert.notEqual(rowOf(r.plan, "A"), rowOf(r.plan, "B"));
});

test("'must not sit together' across two rides, and it can make a ride not fit", () => {
  // 7 men: every row is full, so A and B (apart) can still be split: front + a row.
  const ok = planSeats([ride("a", 4, 0, { people: [man("A", { apart: ["B"] })] }), ride("b", 3, 0, { people: [man("B")] })]);
  assert.ok(ok.ok);
  assert.notEqual(rowOf(ok.plan, "A"), rowOf(ok.plan, "B"));
  // Women can't take the front seat, so three women who must each sit apart from the others can't all fit.
  const bad = planSeats([ride("a", 0, 6, { people: [woman("X", { apart: ["Y", "Z"] }), woman("Y", { apart: ["Z"] }), woman("Z")] })]);
  assert.equal(bad.ok, false);
});

test("husband and wife on separate rides may share a row when they may sit together", () => {
  const rides = (rules) => [
    ride("a", 0, 3),
    ride("b", 2, 0, { people: [man("H", rules)] }),
    ride("c", 0, 1, { people: [woman("W")] }),
  ];
  // Without the rule: front 1 man, 3 women in a row, then a man and a woman from two rides would share the last row.
  assert.equal(planSeats(rides({})).ok, false);
  const r = planSeats(rides({ together: ["W"] }));
  assert.ok(r.ok);
  assert.equal(rowOf(r.plan, "H"), rowOf(r.plan, "W"));
});

test("a row with a man and woman who may sit together takes no one else", () => {
  // 3 women fill one row. H and W (may sit together) share the other; a stranger man S fits only in front.
  const rides = (strangers) => [
    ride("e", 0, 3),
    ride("b", 1, 0, { people: [man("H", { together: ["W"] })] }),
    ride("c", 0, 1, { people: [woman("W")] }),
    ride("d", strangers, 0, { people: [man("S")] }),
  ];
  const r = planSeats(rides(1));
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(r.plan.d), ["front"]); // S has no rule, so he is only counted
  assert.equal(rowOf(r.plan, "H"), rowOf(r.plan, "W"));
  // A second stranger would have to sit in their row: not allowed.
  assert.equal(planSeats(rides(2)).ok, false);
});

test("more named people than the ride's men and women is refused", () => {
  assert.equal(planSeats([ride("a", 1, 0, { people: [man("A"), man("B")] })]).reason, "bad_people");
});
