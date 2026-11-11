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
