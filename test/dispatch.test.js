import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { bookRide, previewAccept, acceptRide, refreshDay, dayRoute } from "../src/dispatch.js";
import { changeStatus, getBooking } from "../src/bookings.js";
import { DEFAULT_SETTINGS } from "../src/rules.js";
import { updateSettings } from "../src/settings.js";
import { createTravel } from "../src/travel.js";

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
  db.prepare("INSERT INTO places (id, household_id, code, kind, name, address) VALUES ('home', 'hh1', '1', 'home', 'Home', '1 Example Ln')").run();
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

test("seats that don't fit the rules: the request still reaches the driver, who is told and may take it anyway", async () => {
  const db = setup();
  const travel = fakeTravel();
  // 2 men and 5 women: one man in front, the other man would need a row of his own, so the rules don't fit 7.
  const r = await bookRide(db, travel, ask({ men: 2, women: 5 }), now, settings);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.seatConflict, true);
  const id = r.bookings[0].id;
  const p = await previewAccept(db, travel, id, settings, now);
  assert.equal(p.ok, true);
  assert.equal(p.seatConflict, true);
  // Without "anyway" it is refused with the reason; with it, it is taken and the seats are only counted.
  const no = await acceptRide(db, travel, id, "drv1", settings, now);
  assert.deepEqual(no.errors, ["no_seats"]);
  assert.equal(no.seatConflict, true);
  const yes = await acceptRide(db, travel, id, "drv1", settings, now, { override: true });
  assert.ok(yes.ok);
  assert.equal(getBooking(db, id).seat_override, 1);
  assert.equal(getBooking(db, id).seats, null);
  // The van is still never over 7: one more person at the same time doesn't fit at all.
  const more = await bookRide(db, travel, ask({ men: 1 }), now, settings);
  assert.equal(more.ok, false);
  // A normal ride later in the day still fits.
  const later = await bookRide(db, travel, ask({ pickupMinute: 15 * 60 }), now, settings);
  assert.ok(later.ok);
  assert.ok((await acceptRide(db, travel, later.bookings[0].id, "drv1", settings, now)).ok);
  assert.equal((await refreshDay(db, travel, day, settings, now)).ok, true);
});

test("two rides accepted at the same moment both end up on the route, one after the other", async () => {
  const db = setup();
  const travel = fakeTravel();
  // Two full vans for the same time: the driver may take both, the second one late (it waits for the first).
  const a = await bookRide(db, travel, ask({ men: 7 }), now, settings);
  const b = await bookRide(db, travel, ask({ men: 7 }), now, settings);
  assert.ok(a.ok && b.ok);
  const out = await Promise.all([a, b].map((r) => acceptRide(db, travel, r.bookings[0].id, "drv1", settings, now)));
  assert.deepEqual(out.map((o) => o.ok), [true, true]);
  const full = dayRoute(db, day).stops;
  assert.equal(full.length, 4);
  assert.deepEqual(full.map((s) => s.kind), ["pickup", "dropoff", "pickup", "dropoff"]);
  // Two small rides at once: both are on the route.
  const c = await bookRide(db, travel, ask({ pickupMinute: 15 * 60 }), now, settings);
  const d = await bookRide(db, travel, ask({ pickupMinute: 15 * 60 }), now, settings);
  const both = await Promise.all([c, d].map((r) => acceptRide(db, travel, r.bookings[0].id, "drv1", settings, now)));
  assert.deepEqual(both.map((o) => o.ok), [true, true]);
  assert.equal(dayRoute(db, day).stops.length, 8);
});

test("the driver may take a ride he'd reach after its window: the preview shows the asked time and the GPS time, nobody else moves", async () => {
  const db = setup();
  const travel = fakeTravel();
  const a = (await bookRide(db, travel, ask({ men: 7 }), now, settings)).bookings[0];
  const b = (await bookRide(db, travel, ask({ men: 7 }), now, settings)).bookings[0];
  assert.ok((await acceptRide(db, travel, a.id, "drv1", settings, now)).ok);
  const etaA = getBooking(db, a.id).eta_minute;
  const p = await previewAccept(db, travel, b.id, settings, now);
  assert.ok(p.ok, JSON.stringify(p));
  assert.equal(p.asked, b.pickup_minute);
  assert.ok(p.eta > b.pickup_minute + b.window_minutes, "the real (later) time");
  assert.deepEqual(p.shifts, {}, "the ride already taken keeps its time");
  assert.ok((await acceptRide(db, travel, b.id, "drv1", settings, now)).ok);
  assert.equal(getBooking(db, b.id).eta_minute, p.eta, "the caller is told the real time");
  assert.equal(getBooking(db, a.id).eta_minute, etaA);
  // An on-time ride shows no asked time.
  const c = (await bookRide(db, travel, ask({ pickupMinute: 15 * 60 }), now, settings)).bookings[0];
  assert.equal((await previewAccept(db, travel, c.id, settings, now)).asked, undefined);
});

test("a package rides along on the route with no seats", async () => {
  const db = setup();
  const travel = fakeTravel();
  const a = (await bookRide(db, travel, ask({ men: 1, women: 6 }), now, settings)).bookings[0];
  assert.ok((await acceptRide(db, travel, a.id, "drv1", settings, now)).ok);
  const b = await bookRide(db, travel, ask({ package: true, pickup: { address: "3 Other St" }, pickupMinute: 12 * 60 + 5 }), now, settings);
  assert.ok(b.ok, JSON.stringify(b));
  assert.ok((await acceptRide(db, travel, b.bookings[0].id, "drv1", settings, now)).ok);
  const route = dayRoute(db, day);
  assert.equal(route.stops.length, 4);
  assert.ok(route.seatsByStop.every((s) => s.rows.reduce((n, r) => n + r.men + r.women, 0) <= 7));
});

test("drive times from the driver's own spot are asked only one way, to the stops of the coming hour, and a waiting driver's spot stays the same", async () => {
  const db = setup();
  const travel = fakeTravel();
  const asked = [];
  travel.ensure = async (legs) => { asked.push(...legs); };
  for (const m of [10 * 60 + 30, 15 * 60]) {
    const r = await bookRide(db, travel, ask({ pickupMinute: m }), now, settings);
    await acceptRide(db, travel, r.bookings[0].id, "drv1", settings, now);
  }
  const seen = new Date(now.getTime() - 60000).toISOString();
  db.prepare("UPDATE drivers SET status = 'online', last_lat = 43.00012, last_lng = -74.00031, last_seen_at = ? WHERE id = 'drv1'").run(seen);
  asked.length = 0;
  await refreshDay(db, travel, day, settings, now);
  const spot = "43.00000,-74.00000";
  assert.ok(asked.some((l) => l.a === spot), "the driver's spot, to about 100 metres");
  assert.ok(!asked.some((l) => l.b === spot), "never back to where the driver is");
  // Home and the shul of the 10:30 ride; the 3 PM ride is hours away.
  assert.deepEqual([...new Set(asked.filter((l) => l.a === spot).map((l) => l.b))].sort(), ["41.00000,-74.00000", "51.00000,-74.00000"]);
  assert.equal(asked.filter((l) => l.a === spot).length, 2);
  // A few metres on (still waiting at the same stop): the same spot.
  db.prepare("UPDATE drivers SET last_lat = 43.00041, last_lng = -74.00012 WHERE id = 'drv1'").run();
  asked.length = 0;
  await refreshDay(db, travel, day, settings, now);
  assert.ok(asked.filter((l) => l.a.startsWith("43.")).every((l) => l.a === spot));
});

test("a booking on a full day is answered at once (14 rides on the route used to freeze the server for minutes)", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hh1', 'Family A', 'x')").run();
  db.prepare("INSERT INTO phones (number, household_id) VALUES ('+18455550001', 'hh1')").run();
  db.prepare("INSERT INTO drivers (id, name, phone) VALUES ('drv1', 'Driver', '+18455550100')").run();
  for (let i = 0; i < 12; i++) {
    db.prepare("INSERT INTO places (id, household_id, code, name, address, lat, lng) VALUES (?, NULL, ?, ?, ?, ?, ?)")
      .run(`p${i}`, String(i + 1), `P${i}`, `${i} St`, 41.1 + (i % 4) * 0.012, -74.07 + Math.floor(i / 4) * 0.015);
  }
  const travel = createTravel(db, {}); // no map key: straight-line estimates
  const book = (extra) => bookRide(db, travel, { phone: "+18455550001", riderName: "R", window: 15, ...extra }, now, DEFAULT_SETTINGS);
  for (let i = 0; i < 14; i++) {
    const r = await book({ men: i % 3 === 0 ? 3 : 1, women: i % 3 === 1 ? 3 : i % 3 === 2 ? 2 : 0, pickup: { placeId: `p${i % 12}` }, dropoff: { placeId: `p${(i + 5) % 12}` }, pickupMinute: 10 * 60 + 15 + i * 25 });
    assert.ok(r.ok, JSON.stringify(r.errors));
    assert.ok((await acceptRide(db, travel, r.bookings[0].id, "drv1", DEFAULT_SETTINGS, now, { override: true })).ok);
  }
  const t = Date.now();
  const r = await book({ men: 2, women: 2, pickup: { placeId: "p1" }, dropoff: { placeId: "p7" }, pickupMinute: null });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
});

test("rides at the same time get real times, and a rider pushed later hears the new time", async () => {
  const { rideAction } = await import("../src/actions.js");
  const db = setup();
  db.prepare("UPDATE phones SET notify = 'text'").run();
  const travel = fakeTravel();
  const sent = [];
  const { notifyBooking } = await import("../src/notify.js");
  const c = { db, travel, settings, now, notify: (b, kind, payload) => { sent.push({ id: b.id, kind, minute: payload?.minute }); notifyBooking(db, b, kind, payload); } };
  const spot = (lat) => db.prepare("UPDATE drivers SET last_lat = ?, last_lng = -74, last_seen_at = ?").run(lat, now.toISOString());
  // Three requests for 10:00 from three places: the driver is at the first one.
  spot(41);
  const book = async (from, to) => (await bookRide(db, travel, ask({ pickup: { address: from }, dropoff: { address: to }, pickupMinute: 600 }), now, settings)).bookings[0];
  const a = await book("1 Example Ln", "5 Sample Rd");
  const b = await book("3 Other St", "5 Sample Rd");
  assert.ok((await rideAction(c, a.id, "accept", {}, "driver:drv1", "drv1")).ok);
  assert.equal(getBooking(db, a.id).eta_minute, 600);
  assert.ok((await rideAction(c, b.id, "accept", {}, "driver:drv1", "drv1")).ok);
  // Not everyone at 10:00: b is 5 minutes on from a.
  assert.equal(getBooking(db, a.id).eta_minute, 600);
  assert.equal(getBooking(db, b.id).eta_minute, 605);
  // The driver went to 51 meanwhile; a third ride there makes a's pickup 10 minutes later than a was told.
  spot(51);
  const d = await book("5 Sample Rd", "3 Other St");
  db.prepare("UPDATE deliveries SET status = 'sent'").run();
  sent.length = 0;
  const r = await rideAction(c, d.id, "accept", {}, "driver:drv1", "drv1");
  assert.ok(r.ok);
  const aNow = getBooking(db, a.id).eta_minute;
  assert.ok(aNow >= 605, String(aNow));
  assert.deepEqual(sent.filter((x) => x.id === a.id), [{ id: a.id, kind: "late", minute: aNow }]);
});

test("a rider pushed later before their 'accepted' text went out gets that text with the new time, not two messages", async () => {
  const { tellMoved } = await import("../src/actions.js");
  const { notifyBooking } = await import("../src/notify.js");
  const db = setup();
  db.prepare("UPDATE phones SET notify = 'text'").run();
  const travel = fakeTravel();
  const a = (await bookRide(db, travel, ask(), now, settings)).bookings[0];
  await acceptRide(db, travel, a.id, "drv1", settings, now);
  notifyBooking(db, getBooking(db, a.id), "accepted");
  db.prepare("UPDATE bookings SET eta_minute = 735 WHERE id = ?").run(a.id);
  tellMoved({ db, notify: (b, kind, p) => notifyBooking(db, b, kind, p) }, [getBooking(db, a.id)]);
  const rows = db.prepare("SELECT kind, body FROM deliveries WHERE booking_id = ?").all(a.id);
  assert.deepEqual(rows.map((r) => r.kind), ["accepted"]);
  const { timeText } = await import("../src/phone/words.js");
  assert.ok(rows[0].body.includes(timeText(735)));
});

test("admin setting 'just count the seats': no row rules, the driver seats people, never more than 7", async () => {
  const db = setup();
  const travel = fakeTravel();
  assert.ok(updateSettings(db, { seatRows: false }, "admin:test").ok);
  // 2 men and 5 women don't fit the rows, but with seats only counted it is a plain request.
  const r = await bookRide(db, travel, ask({ men: 2, women: 5 }), now, settings);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.seatConflict, false);
  const id = r.bookings[0].id;
  assert.equal((await previewAccept(db, travel, id, settings, now)).seatConflict, false);
  const yes = await acceptRide(db, travel, id, "drv1", settings, now);
  assert.ok(yes.ok, JSON.stringify(yes));
  assert.equal(getBooking(db, id).seats, null, "no row plan");
  assert.equal(getBooking(db, id).seat_override, 1, "stays counted if the setting goes back to rows");
  assert.equal(dayRoute(db, day).countOnly, true);
  const more = await bookRide(db, travel, ask({ men: 1 }), now, settings);
  assert.equal(more.ok, false, "an eighth person doesn't fit");
  // Back to rows: the ride already taken stays, and the day still plans.
  assert.ok(updateSettings(db, { seatRows: true }, "admin:test").ok);
  assert.equal(dayRoute(db, day).countOnly, false);
  assert.equal((await refreshDay(db, travel, day, settings, now)).ok, true);
});

test("the seat and phone settings take only yes or no", () => {
  const db = setup();
  assert.equal(updateSettings(db, { seatRows: "no" }, "admin:test").ok, false);
  assert.equal(updateSettings(db, { phoneSayPlace: 1 }, "admin:test").ok, false);
  const r = updateSettings(db, { phoneSayPlace: true }, "admin:test");
  assert.ok(r.ok);
  assert.equal(r.settings.phoneSayPlace, true);
  assert.equal(r.settings.seatRows, true, "rows by default");
});
