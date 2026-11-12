import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { priorityOf, addPriority, removePriority, listPriorities } from "../src/priority.js";
import { bookRide, previewAccept, acceptRide } from "../src/dispatch.js";
import { getBooking } from "../src/bookings.js";
import { buildRoute } from "../src/route.js";
import { todayFor } from "../src/driver.js";
import { createApp } from "../src/server.js";
import { DEFAULT_SETTINGS } from "../src/rules.js";

const now = new Date("2026-11-11T15:00:00Z"); // 10:00 AM New York
const day = "2026-11-11";
const settings = { ...DEFAULT_SETTINGS, stopMinutes: 0 };

// Every address on one road; its latitude is its position, one minute per unit.
const spots = { "1 example ln": 41, "5 sample rd": 51, "2 second ln": 42 };
const fakeTravel = () => ({
  async geocode(a) {
    const x = spots[String(a).trim().toLowerCase()];
    return x == null ? null : { lat: x, lng: -74 };
  },
  async ensure() {},
  minutes(a, b) {
    if (!a || !b) return { minutes: 15, estimated: true };
    return { minutes: Math.abs(Number(a.split(",")[0]) - Number(b.split(",")[0])), estimated: false };
  },
});

function setup() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hhA', 'Family A', 'x'), ('hhB', 'Family B', 'x')").run();
  db.prepare("INSERT INTO passengers (id, household_id, name, gender) VALUES ('mom', 'hhB', 'Mother', 'f'), ('kid', 'hhB', 'Son', 'm')").run();
  db.prepare("INSERT INTO phones (number, household_id) VALUES ('+18455550001', 'hhA')").run();
  db.prepare("INSERT INTO phones (number, household_id, passenger_id) VALUES ('+18455550002', 'hhB', 'mom'), ('+18455550003', 'hhB', NULL)").run();
  db.prepare("INSERT INTO places (id, household_id, code, name, address) VALUES ('shul', NULL, '20', 'Shul', '5 Sample Rd'), ('homeA', 'hhA', '01', 'Home', '1 Example Ln'), ('homeB', 'hhB', '01', 'Home', '2 Second Ln')").run();
  db.prepare("INSERT INTO drivers (id, name, phone) VALUES ('drv1', 'Driver', '+18455550100')").run();
  return db;
}
const ride = (extra) => ({ day, household_id: "hhB", booked_by_phone: "+18455550003", passenger_id: null, pickup_minute: 720, ...extra });

test("a family's priority covers every ride of the family; outside its time range it's normal", () => {
  const db = setup();
  assert.equal(priorityOf(db, ride()).level, 0);
  assert.ok(addPriority(db, { householdId: "hhB", level: 1, from: "2026-11-11T11:00", to: "2026-11-11T13:00" }, "admin:x").ok);
  assert.equal(priorityOf(db, ride()).label, "High");
  assert.equal(priorityOf(db, ride({ pickup_minute: 13 * 60 })).level, 0); // the end is not included
  assert.equal(priorityOf(db, ride({ day: "2026-11-12" })).level, 0);
  assert.equal(priorityOf(db, ride({ household_id: "hhA" })).level, 0);
});

test("a person's priority covers their rides: picked on the booking, or the phone that is theirs", () => {
  const db = setup();
  addPriority(db, { householdId: "hhB", passengerId: "mom", level: 2 }, "admin:x"); // always
  assert.equal(priorityOf(db, ride({ passenger_id: "mom" })).level, 2);
  assert.equal(priorityOf(db, ride({ booked_by_phone: "+18455550002" })).level, 2);
  assert.equal(priorityOf(db, ride({ passenger_id: "kid" })).level, 0);
  assert.equal(priorityOf(db, ride()).level, 0);
  // The highest rule wins when a family and a person rule both apply.
  addPriority(db, { householdId: "hhB", level: 1 }, "admin:x");
  assert.equal(priorityOf(db, ride({ passenger_id: "kid" })).level, 1);
  assert.equal(priorityOf(db, ride({ passenger_id: "mom" })).level, 2);
});

test("priority rules are checked, listed and removed", () => {
  const db = setup();
  assert.equal(addPriority(db, { householdId: "hhB", level: 5 }, "a").ok, false);
  assert.equal(addPriority(db, { householdId: "nope", level: 1 }, "a").ok, false);
  assert.equal(addPriority(db, { householdId: "hhA", passengerId: "mom", level: 1 }, "a").ok, false);
  assert.equal(addPriority(db, { householdId: "hhB", level: 1, from: "2026-11-11T13:00", to: "2026-11-11T12:00" }, "a").ok, false);
  assert.equal(addPriority(db, { householdId: "hhB", level: 1, from: "tomorrow" }, "a").ok, false);
  const r = addPriority(db, { householdId: "hhB", passengerId: "mom", level: 2, note: "doctor visits" }, "a");
  assert.equal(listPriorities(db)[0].passenger_name, "Mother");
  assert.ok(removePriority(db, r.id, "a").ok);
  assert.equal(listPriorities(db).length, 0);
  assert.equal(priorityOf(db, ride({ passenger_id: "mom" })).level, 0);
});

const ask = (phone, from, extra = {}) => ({ phone, riderName: "R", men: 0, women: 0, pickup: { placeId: from }, dropoff: { placeId: "shul" }, pickupMinute: 720, window: 15, ...extra });

test("the driver sees higher-priority requests first, marked", async () => {
  const db = setup();
  addPriority(db, { householdId: "hhB", level: 2 }, "a");
  const travel = fakeTravel();
  await bookRide(db, travel, ask("+18455550001", "homeA", { men: 1, pickupMinute: 11 * 60 }), now, settings);
  await bookRide(db, travel, ask("+18455550003", "homeB", { men: 1, pickupMinute: 12 * 60 }), now, settings);
  const t = todayFor(db, { day, minute: 600 });
  assert.deepEqual(t.requests.map((r) => r.priority_label), ["Top", "Normal"]);
});

test("accepting a ride that leaves no room for a waiting higher-priority one is flagged first", async () => {
  const db = setup();
  addPriority(db, { householdId: "hhB", level: 2 }, "a");
  const travel = fakeTravel();
  // 4 women take rows 2 and 3; then 2 men can't fit (the front seat holds one man).
  const low = (await bookRide(db, travel, ask("+18455550001", "homeA", { women: 4 }), now, settings)).bookings[0];
  const top = (await bookRide(db, travel, ask("+18455550003", "homeB", { men: 2 }), now, settings)).bookings[0];
  const p = await previewAccept(db, travel, low.id, settings, now);
  assert.ok(p.ok);
  assert.deepEqual(p.blocks.map((b) => [b.id, b.label]), [[top.id, "Top"]]);
  const q = await previewAccept(db, travel, top.id, settings, now);
  assert.equal(q.priority.label, "Top");
  assert.deepEqual(q.blocks, []); // the other ride is lower priority: no warning
  // The driver may still accept; it's recorded.
  const a = await acceptRide(db, travel, low.id, "drv1", settings, now);
  assert.ok(a.ok);
  assert.equal(a.blocks.length, 1);
  assert.match(db.prepare("SELECT details FROM audit WHERE action = 'accepted'").get().details, /blocksPriority/);
});

test("priority never moves an accepted ride: a top-priority request that only fits by bumping it is refused", async () => {
  const db = setup();
  const travel = fakeTravel();
  const low = (await bookRide(db, travel, ask("+18455550001", "homeA", { women: 4 }), now, settings)).bookings[0];
  assert.ok((await acceptRide(db, travel, low.id, "drv1", settings, now)).ok);
  const before = getBooking(db, low.id);
  addPriority(db, { householdId: "hhB", level: 2 }, "a");
  const r = await bookRide(db, travel, ask("+18455550003", "homeB", { men: 2 }), now, settings);
  // Only the seat rules stop it: it waits for the driver, who decides, and the accepted ride doesn't move.
  assert.equal(r.seatConflict, true);
  assert.equal(r.bookings[0].status, "pending");
  const after = getBooking(db, low.id);
  assert.equal(after.status, "accepted");
  assert.equal(after.eta_minute, before.eta_minute);
  assert.equal(after.seats, before.seats);
});

test("between two equally good orders, the planner picks up the higher-priority rider first", () => {
  const ctx = { minutes: fakeTravel().minutes, stopMinutes: 0, maxTrip: 30, start: { at: "50,-74", minute: 720 } };
  const r = (id, at, priority) => ({ id, men: 1, women: 0, together: false, windowStart: 720, windowEnd: 735, from: `${at},-74`, to: "50,-74", onBoard: false, priority });
  for (const rides of [[r("x", 45, 0), r("y", 55, 2)], [r("y", 55, 2), r("x", 45, 0)]]) {
    const built = buildRoute(rides, ctx);
    assert.ok(built.ok);
    assert.equal(built.stops[0].ride, "y");
  }
  // And the other way round when x is the higher one.
  assert.equal(buildRoute([r("x", 45, 1), r("y", 55, 0)], ctx).stops[0].ride, "x");
});

test("admins set and remove priorities through the API, and bookings show their level", async () => {
  const db = openDb(":memory:");
  const app = createApp(db, { ADMIN_EMAIL: "a@example.com", ADMIN_PASSWORD: "first-password-1" });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const call = async (path, method = "GET", body) => {
    const res = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    await call("/api/login", "POST", { email: "a@example.com", password: "first-password-1" });
    const hh = (await call("/api/admin/households", "POST", { name: "Family" })).body.id;
    assert.equal((await call("/api/admin/priorities", "POST", { householdId: hh, level: 9 })).status, 400);
    const added = await call("/api/admin/priorities", "POST", { householdId: hh, level: 1, from: "2026-11-11T10:00", to: "2026-11-11T18:00" });
    assert.equal(added.status, 200);
    const list = (await call("/api/admin/priorities")).body;
    assert.equal(list[0].label, "High");
    db.prepare(`INSERT INTO bookings (id, day, household_id, booked_by_phone, rider_name, men, women, pickup_address, dropoff_address,
      pickup_minute, window_minutes, created_at, updated_at) VALUES ('bk1', '2026-11-11', ?, '+1', 'R', 1, 0, 'a', 'b', 720, 15, 'x', 'x')`).run(hh);
    assert.equal((await call("/api/admin/bookings?day=2026-11-11")).body[0].priority_label, "High");
    assert.equal((await call(`/api/admin/priorities/${added.body.id}`, "DELETE")).status, 200);
    assert.equal((await call("/api/admin/priorities")).body.length, 0);
  } finally {
    server.close();
  }
});
