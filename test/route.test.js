import test from "node:test";
import assert from "node:assert/strict";
import { timeRoute, insertRide, buildRoute, fitRides, etas } from "../src/route.js";

// Points on a straight road: the key is the position, and driving takes one minute per unit.
const ctx = { minutes: (a, b) => ({ minutes: Math.abs(Number(a) - Number(b)), estimated: false }), stopMinutes: 0, maxTrip: 30 };
const ride = (id, from, to, start, extra = {}) => ({ id, men: 1, women: 0, together: false, from: String(from), to: String(to), windowStart: start, windowEnd: start + 15, onBoard: false, ...extra });

test("timing waits for a window to open and flags a late pickup", () => {
  const rides = [ride("a", 0, 10, 600), ride("b", 50, 60, 600)];
  const stops = [{ ride: "a", kind: "pickup" }, { ride: "a", kind: "dropoff" }, { ride: "b", kind: "pickup" }, { ride: "b", kind: "dropoff" }];
  const t = timeRoute(stops, rides, ctx);
  assert.deepEqual(t.times.map((x) => x.arrive), [600, 610, 650, 660]);
  assert.equal(t.late.b, 35);
  assert.equal(t.drive, 60);
});

test("a second rider going the same way is picked up on the way", () => {
  const a = ride("a", 0, 20, 600);
  const first = buildRoute([a], ctx);
  const res = insertRide(first.stops, [a], ride("b", 5, 15, 600), ctx);
  assert.ok(res.ok);
  assert.deepEqual(res.stops.map((s) => `${s.ride}.${s.kind}`), ["a.pickup", "b.pickup", "b.dropoff", "a.dropoff"]);
  assert.equal(res.timing.drive, 20);
});

test("a new ride that would make a promised rider late is refused", () => {
  const a = ride("a", 0, 10, 600);
  const b = ride("b", 10, 20, 615);
  const route = buildRoute([a, b], ctx);
  assert.ok(route.ok);
  // Going out to 100 and back can't fit between them, and before or after doesn't fit its own window.
  const res = insertRide(route.stops, [a, b], ride("c", 100, 110, 605, { windowEnd: 612 }), ctx);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_time");
});

test("nobody rides longer than the trip limit", () => {
  const a = ride("a", 0, 25, 600);
  const route = buildRoute([a], ctx);
  // Picking up b at 40 on the way would keep a on board 65 minutes; b has to wait until after.
  const res = insertRide(route.stops, [a], ride("b", 40, 45, 600, { windowEnd: 660 }), ctx);
  assert.ok(res.ok);
  assert.deepEqual(res.stops.map((s) => `${s.ride}.${s.kind}`), ["a.pickup", "a.dropoff", "b.pickup", "b.dropoff"]);
  assert.deepEqual(res.timing.over, {});
});

test("seats: a 7th woman doesn't fit, a man takes the front seat", () => {
  const six = ride("w6", 0, 20, 600, { men: 0, women: 6 });
  const route = buildRoute([six], ctx);
  assert.ok(route.ok);
  const woman = insertRide(route.stops, [six], ride("w", 0, 20, 600, { men: 0, women: 1 }), ctx);
  assert.equal(woman.ok, false);
  assert.equal(woman.reason, "no_seats");
  const man = insertRide(route.stops, [six], ride("m", 0, 20, 600), ctx);
  assert.ok(man.ok);
  assert.deepEqual(man.seats.m, { front: { men: 1, women: 0 } });
});

test("a rider on board keeps their seats", () => {
  const onBoard = ride("a", 0, 20, 590, { men: 0, women: 2, onBoard: true, pickedUpAt: 595, seats: { row3: { men: 0, women: 2 } } });
  const c2 = { ...ctx, start: { at: "0", minute: 600 } };
  const built = buildRoute([onBoard], c2);
  assert.ok(built.ok);
  assert.deepEqual(built.seats.a, { row3: { men: 0, women: 2 } });
  // Three men can sit in row 2 next to them, but not where they are.
  const res = insertRide(built.stops, [onBoard], ride("m", 5, 15, 600, { men: 3 }), c2);
  assert.ok(res.ok);
  assert.deepEqual(res.seats.a, { row3: { men: 0, women: 2 } });
  assert.deepEqual(res.seats.m, { row2: { men: 3, women: 0 } });
});

test("fitRides puts a ride with a tight window ahead of the saved order", () => {
  // Saved order serves b before a; the new ride only fits when a goes first.
  const a = ride("a", 0, 5, 600, { windowEnd: 640 });
  const b = ride("b", 10, 15, 600, { windowEnd: 640 });
  const stops = [{ ride: "b", kind: "pickup" }, { ride: "b", kind: "dropoff" }, { ride: "a", kind: "pickup" }, { ride: "a", kind: "dropoff" }];
  const c = ride("c", 0, 1, 600, { windowEnd: 602 });
  const res = fitRides(stops, [a, b], [c], ctx);
  assert.ok(res.ok);
  const e = etas(res.stops, res.timing);
  assert.ok(e.c.pickup <= 602);
  assert.ok(e.a.pickup <= 640 && e.b.pickup <= 640);
});

test("overlapping rides go in road order: A 1→3 and B 2→4 make 1, 2, 3, 4", () => {
  const order = (stops) => stops.map((s) => `${s.ride}.${s.kind}`);
  const want = ["a.pickup", "b.pickup", "a.dropoff", "b.dropoff"];
  const a = ride("a", 10, 30, 600);
  const b = ride("b", 20, 40, 600);
  // Both booked ahead of time.
  const both = buildRoute([a, b], ctx);
  assert.ok(both.ok);
  assert.deepEqual(order(both.stops), want);
  assert.equal(both.timing.drive, 30, "no driving back and forth");
  // B calls in while the driver is on the way with A (A is on board, the van is at 15): B fits on the way.
  const onBoard = { ...a, onBoard: true, pickedUpAt: 600 };
  const atStart = [{ ride: "a", kind: "dropoff" }];
  const res = insertRide(atStart, [onBoard], ride("b", 20, 40, 605), { ...ctx, start: { at: "15", minute: 605 } });
  assert.ok(res.ok);
  assert.deepEqual(order(res.stops), ["b.pickup", "a.dropoff", "b.dropoff"]);
});
