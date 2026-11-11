import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { bookRide, previewAccept, acceptRide, refreshDay, dayRoute } from "../src/dispatch.js";
import { changeStatus, getBooking } from "../src/bookings.js";
import { DEFAULT_SETTINGS } from "../src/rules.js";

const now = new Date("2026-11-11T15:00:00Z"); // 10:00 AM New York
const day = "2026-11-11";

// A pretend map: every address sits on one road, its latitude is its position, one minute per unit.
const spots = { "1 example ln": 41, "5 sample rd": 51, "9 far away rd": 90, "3 other st": 46 };
function fakeTravel() {
  const calls = { geocode: 0, ensure: 0 };
  return {
    calls,
    async geocode(address) {
      calls.geocode++;
      const x = spots[String(address).trim().toLowerCase()];
      return x == null ? null : { lat: x, lng: -74 };
    },
    async ensure() {
      calls.ensure++;
    },
    minutes(a, b) {
      if (!a || !b) return { minutes: 15, estimated: true };
      return { minutes: Math.abs(Number(a.split(",")[0]) - Number(b.split(",")[0])), estimated: false };
    },
  };
}

function setup() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hh1', 'Family A', 'x')").run();
  db.prepare("INSERT INTO phones (number, household_id) VALUES ('+18455550001', 'hh1')").run();
  db.prepare("INSERT INTO places (id, household_id, code, kind, name, address) VALUES ('home', 'hh1', '01', 'home', 'Home', '1 Example Ln')").run();
  db.prepare("INSERT INTO places (id, household_id, code, name, address) VALUES ('shul', NULL, '20', 'Shul', '5 Sample Rd')").run();
  db.prepare("INSERT INTO drivers (id, name, phone) VALUES ('drv1', 'Driver', '+18455550100')").run();
  return db;
}
const ask = (extra = {}) => ({ phone: "+18455550001", riderName: "Test", men: 1, women: 0, pickup: { placeId: "home" }, dropoff: { placeId: "shul" }, pickupMinute: 12 * 60, window: 15, ...extra });
const settings = { ...DEFAULT_SETTINGS, stopMinutes: 0 };

test("booking finds the map points, saves them on the place, and gives an ETA", async () => {
  const db = setup();
  const travel = fakeTravel();
  const r = await bookRide(db, travel, ask(), now, settings);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.bookings[0].pickup_lat, 41);
  assert.equal(db.prepare("SELECT lat FROM places WHERE id = 'home'").get().lat, 41);
  assert.equal(r.etas[r.bookings[0].id], 720);
  // The place's point is used next time, no new lookup.
  const before = travel.calls.geocode;
  await bookRide(db, travel, ask({ pickupMinute: 13 * 60 }), now, settings);
  assert.equal(travel.calls.geocode, before);
});

test("a ride longer than the trip limit is refused as too far", async () => {
  const db = setup();
  const r = await bookRide(db, fakeTravel(), ask({ dropoff: { address: "9 Far Away Rd" } }), now, settings);
  assert.deepEqual(r.errors, ["too_far"]);
  assert.equal(r.minutes, 49);
});

test("accepting shows whose times move, then saves the route, seats and ETAs", async () => {
  const db = setup();
  const travel = fakeTravel();
  const a = (await bookRide(db, travel, ask({ dropoff: { address: "5 Sample Rd" } }), now, settings)).bookings[0];
  assert.ok((await acceptRide(db, travel, a.id, "drv1", settings, now)).ok);
  // b starts on the way (at 46) a little later, so a's drop-off moves later only by the stop.
  const b = (await bookRide(db, travel, ask({ pickup: { address: "3 Other St" }, pickupMinute: 12 * 60 + 5 }), now, settings)).bookings[0];
  const p = await previewAccept(db, travel, b.id, settings, now);
  assert.ok(p.ok, JSON.stringify(p));
  assert.deepEqual(p.after.stops.map((s) => s.kind), ["pickup", "pickup", "dropoff", "dropoff"]);
  assert.equal(p.eta, 12 * 60 + 5);
  assert.deepEqual(p.shifts, {});
  const r = await acceptRide(db, travel, b.id, "drv1", settings, now);
  assert.ok(r.ok);
  const route = dayRoute(db, day);
  assert.equal(route.stops.length, 4);
  assert.equal(route.driveMinutes, 10);
  assert.ok(getBooking(db, a.id).seats && getBooking(db, b.id).seats);
  assert.equal(getBooking(db, b.id).eta_dropoff_minute, 12 * 60 + 10);
  // Two men on board between the two pickups and drop-offs.
  assert.equal(route.seatsByStop[1].rows.reduce((n, r) => n + r.men, 0), 2);
});

test("no room: the caller gets the nearest times that fit", async () => {
  const db = setup();
  const travel = fakeTravel();
  const big = (await bookRide(db, travel, ask({ men: 1, women: 6 }), now, settings)).bookings[0];
  assert.ok((await acceptRide(db, travel, big.id, "drv1", settings, now)).ok);
  const r = await bookRide(db, travel, ask({ men: 0, women: 1 }), now, settings);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ["no_seats"]);
  assert.deepEqual(r.suggestions, [11 * 60 + 45, 12 * 60 + 15]);
});

test("cancelling frees the seats and re-times the day; pickups keep seats", async () => {
  const db = setup();
  const travel = fakeTravel();
  const a = (await bookRide(db, travel, ask({ men: 0, women: 3 }), now, settings)).bookings[0];
  const b = (await bookRide(db, travel, ask({ men: 0, women: 3 }), now, settings)).bookings[0];
  await acceptRide(db, travel, a.id, "drv1", settings, now);
  await acceptRide(db, travel, b.id, "drv1", settings, now);
  assert.equal(dayRoute(db, day).stops.length, 4);
  changeStatus(db, b.id, "cancel", "admin");
  await refreshDay(db, travel, day, settings, now);
  assert.equal(dayRoute(db, day).stops.length, 2);
  const seats = getBooking(db, a.id).seats;
  changeStatus(db, a.id, "pickup", "driver:drv1", new Date("2026-11-11T17:01:00Z"), settings);
  assert.equal(getBooking(db, a.id).picked_up_minute, 12 * 60 + 1);
  const r = await refreshDay(db, travel, day, settings, new Date("2026-11-11T17:01:00Z"));
  assert.ok(r.ok);
  assert.deepEqual(dayRoute(db, day).stops.map((s) => s.kind), ["dropoff"]);
  assert.equal(getBooking(db, a.id).seats, seats);
  changeStatus(db, a.id, "done", "driver:drv1");
  await refreshDay(db, travel, day, settings, now);
  assert.equal(dayRoute(db, day).stops.length, 0);
});

test("an address Google can't find still plans, with the legs marked as guessed", async () => {
  const db = setup();
  const travel = fakeTravel();
  const a = (await bookRide(db, travel, ask({ pickup: { address: "Nowhere Known" } }), now, settings)).bookings[0];
  await acceptRide(db, travel, a.id, "drv1", settings, now);
  assert.equal(getBooking(db, a.id).pickup_lat, null);
  assert.equal(dayRoute(db, day).estimated, true);
});
