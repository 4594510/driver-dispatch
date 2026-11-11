import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { requestRide, acceptBooking, changeStatus } from "../src/bookings.js";

const now = new Date("2026-11-11T16:00:00Z"); // 11:00 AM New York

function setup() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hh1', 'Family A', 'x')").run();
  db.prepare("INSERT INTO phones (number, household_id) VALUES ('+18455550001', 'hh1')").run();
  db.prepare("INSERT INTO places (id, household_id, code, kind, name, address) VALUES ('home', 'hh1', '01', 'home', 'Home', '1 Example Ln, Monsey')").run();
  db.prepare("INSERT INTO places (id, household_id, code, name, address) VALUES ('shul', NULL, '20', 'Shul', '5 Sample Rd, Spring Valley')").run();
  db.prepare("INSERT INTO drivers (id, name, phone) VALUES ('drv1', 'Driver', '+18455550100')").run();
  return db;
}
const ask = (extra = {}) => ({ phone: "+18455550001", riderName: "Test", men: 1, women: 0, pickup: { placeId: "home" }, dropoff: { placeId: "shul" }, pickupMinute: 12 * 60, window: 15, ...extra });

test("unregistered numbers cannot book", () => {
  const db = setup();
  assert.deepEqual(requestRide(db, ask({ phone: "+18455559999" }), now).errors, ["not_registered"]);
});

test("a ride request is saved as pending, with its return trip", () => {
  const db = setup();
  const r = requestRide(db, ask({ returnMinute: 14 * 60 }), now);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.bookings.length, 2);
  assert.equal(r.bookings[0].status, "pending");
  assert.equal(r.bookings[1].return_of, r.bookings[0].id);
  assert.equal(r.bookings[1].pickup_address, "5 Sample Rd, Spring Valley");
  assert.equal(db.prepare("SELECT count(*) n FROM audit").get().n, 2);
});

test("another household's place cannot be used", () => {
  const db = setup();
  db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hh2', 'Family B', 'x')").run();
  db.prepare("INSERT INTO places (id, household_id, code, name, address) VALUES ('other', 'hh2', '01', 'Home', '9 Other St')").run();
  assert.ok(requestRide(db, ask({ pickup: { placeId: "other" } }), now).errors.includes("no_pickup"));
});

test("accepted rides hold seats; a ride that does not fit is refused, and frees up after cancel", () => {
  const db = setup();
  const a = requestRide(db, ask({ men: 0, women: 6 }), now).bookings[0];
  assert.ok(acceptBooking(db, a.id, "drv1").ok);
  const b = requestRide(db, ask({ men: 0, women: 1, pickupMinute: 12 * 60 + 10 }), now);
  assert.deepEqual(b.errors, ["no_seats"]);
  assert.ok(changeStatus(db, a.id, "cancel", "admin").ok);
  assert.ok(requestRide(db, ask({ men: 0, women: 1, pickupMinute: 12 * 60 + 10 }), now).ok);
});

test("status changes follow the ride's life: DONE only after acceptance", () => {
  const db = setup();
  const a = requestRide(db, ask(), now).bookings[0];
  assert.equal(changeStatus(db, a.id, "done", "driver").ok, false);
  acceptBooking(db, a.id, "drv1");
  assert.equal(changeStatus(db, a.id, "pickup", "driver").ok, true);
  assert.equal(changeStatus(db, a.id, "done", "driver").booking.status, "completed");
});
