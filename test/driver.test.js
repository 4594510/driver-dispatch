import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";
import { openDb } from "../src/db.js";
import { driving } from "../src/reports.js";

// A pretend map: every address sits on one road, its latitude is its position, one minute per unit.
const spots = { "1 example ln": 41, "5 sample rd": 51, "3 other st": 46, "7 next ave": 44 };
const travel = {
  geocode: async (a) => (spots[a.toLowerCase()] != null ? { lat: spots[a.toLowerCase()], lng: -74 } : null),
  ensure: async () => {},
  minutes: (a, b) => ({ minutes: a && b ? Math.abs(Number(a.split(",")[0]) - Number(b.split(",")[0])) : 15, estimated: !(a && b) }),
};

async function withDay(fn) {
  const db = openDb(":memory:");
  let clock = new Date("2026-11-11T15:00:00Z"); // 10:00 AM New York
  const app = createApp(db, { ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: "first-password-1" }, { travel, now: () => clock });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  let token = "";
  const call = async (path, method = "GET", body) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...(token && path.startsWith("/api/driver") ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hh1', 'Family A', 'x')").run();
  db.prepare("INSERT INTO phones (number, household_id, notify) VALUES ('+18455550001', 'hh1', 'text')").run();
  db.prepare("INSERT INTO drivers (id, name, phone) VALUES ('drv1', 'Driver', '+18455550100')").run();
  await call("/api/login", "POST", { email: "admin@example.com", password: "first-password-1" });
  try {
    await fn({ call, db, setToken: (t) => (token = t), at: (iso) => (clock = new Date(iso)) });
  } finally {
    server.close();
  }
}
const ride = (extra = {}) => ({ phone: "845-555-0001", riderName: "Test", men: 1, women: 0, pickup: { address: "1 Example Ln" }, dropoff: { address: "5 Sample Rd" }, pickupMinute: 720, window: 15, ...extra });
const texts = (db, kind) => db.prepare("SELECT * FROM deliveries WHERE kind = ?").all(kind);

test("the driver signs in with phone and PIN; a wrong PIN or no token is refused", async () => {
  await withDay(async ({ call, setToken }) => {
    assert.equal((await call("/api/driver/today")).status, 401);
    assert.equal((await call("/api/admin/drivers/drv1/pin", "POST", { pin: "12" })).status, 400, "too short");
    assert.equal((await call("/api/admin/drivers/drv1/pin", "POST", { pin: "4321" })).status, 200);
    assert.equal((await call("/api/admin/drivers")).body[0].has_pin, true);
    assert.equal((await call("/api/admin/drivers")).body[0].pin_hash, undefined, "the PIN's hash never leaves the server");
    assert.equal((await call("/api/driver/login", "POST", { phone: "845-555-0100", pin: "0000" })).status, 401);
    const ok = await call("/api/driver/login", "POST", { phone: "(845) 555-0100", pin: "4321" });
    assert.equal(ok.status, 200);
    setToken(ok.body.token);
    assert.equal((await call("/api/driver/today")).body.driver.name, "Driver");
    // A new PIN signs the old phone out.
    await call("/api/admin/drivers/drv1/pin", "POST", { pin: "9999" });
    assert.equal((await call("/api/driver/today")).status, 401);
  });
});

test("a day in the app: online, accept with preview, stops in order, pickup and drop-off, reports", async () => {
  await withDay(async ({ call, db, setToken, at }) => {
    await call("/api/admin/drivers/drv1/pin", "POST", { pin: "4321" });
    setToken((await call("/api/driver/login", "POST", { phone: "8455550100", pin: "4321" })).body.token);

    // Pause runs out by itself.
    const paused = await call("/api/driver/status", "POST", { status: "paused", minutes: 15 });
    assert.equal(paused.body.driver.status, "paused");
    at("2026-11-11T15:16:00Z");
    assert.equal((await call("/api/driver/today")).body.driver.status, "online");

    const a = (await call("/api/admin/bookings", "POST", ride())).body.bookings[0].id;
    const b = (await call("/api/admin/bookings", "POST", ride({ riderName: "Second", pickup: { address: "7 Next Ave" }, dropoff: { address: "3 Other St" }, pickupMinute: 735 }))).body.bookings[0].id;
    let today = (await call("/api/driver/today")).body;
    assert.deepEqual(today.requests.map((r) => r.rider_name), ["Test", "Second"]);

    // Accept the first; the same action sent twice (no signal, sent again) is done once.
    const first = await call(`/api/driver/bookings/${a}/accept`, "POST", { key: "k1" });
    assert.equal(first.status, 200);
    const again = await call(`/api/driver/bookings/${a}/accept`, "POST", { key: "k1" });
    assert.equal(again.body.repeated, true);
    assert.equal(texts(db, "accepted").length, 1);

    const preview = (await call(`/api/driver/requests/${b}/preview`)).body;
    assert.equal(preview.ok, true);
    assert.equal(preview.names[a], "Test");
    assert.equal(preview.after.stops.length, 4);
    assert.equal((await call(`/api/driver/bookings/${b}/accept`, "POST", { key: "k2" })).status, 200);

    today = (await call("/api/driver/today")).body;
    assert.equal(today.requests.length, 0);
    assert.equal(today.route.stops.length, 4);
    assert.equal(today.next.booking_id, a);
    assert.equal(today.next.kind, "pickup");
    assert.equal(today.next.address, "1 Example Ln");
    assert.equal(today.next.phone, "+18455550001");
    assert.ok(today.next.seatsHere, "seats after the stop");

    // Moving a drop-off before its pickup is refused; a valid order is kept by later refreshes.
    const stops = today.route.stops.map((s) => ({ booking_id: s.booking_id, kind: s.kind }));
    const bad = [...stops].reverse();
    assert.equal((await call("/api/driver/route/order", "POST", { stops: bad })).body.errors[0], "dropoff_before_pickup");
    const mine = [
      { booking_id: a, kind: "pickup" }, { booking_id: b, kind: "pickup" }, { booking_id: a, kind: "dropoff" }, { booking_id: b, kind: "dropoff" },
    ];
    const ordered = await call("/api/driver/route/order", "POST", { stops: mine });
    assert.equal(ordered.status, 200, JSON.stringify(ordered.body));
    await call("/api/admin/route/refresh", "POST", {});
    today = (await call("/api/driver/today")).body;
    assert.deepEqual(today.route.stops.map((s) => `${s.booking_id === a ? "A" : "B"}:${s.kind}`), ["A:pickup", "B:pickup", "A:dropoff", "B:dropoff"]);
    assert.equal(today.route.manual, true);

    // GPS on the way; pickup at 12:05, drop-off at 12:20.
    const pts = [];
    for (let i = 0; i <= 10; i++) pts.push({ lat: 41 + i * 0.001, lng: -74, at: new Date(Date.UTC(2026, 10, 11, 16, 50, i * 10)).toISOString() });
    assert.equal((await call("/api/driver/location", "POST", { points: pts })).body.saved, 11);
    assert.equal((await call("/api/admin/drivers")).body[0].last_lat, 41.01);

    at("2026-11-11T17:05:00Z");
    assert.equal((await call(`/api/driver/bookings/${a}/pickup`, "POST", { key: "k3" })).status, 200);
    at("2026-11-11T17:20:00Z");
    assert.equal((await call(`/api/driver/bookings/${a}/done`, "POST", { key: "k4" })).status, 200);
    assert.equal((await call(`/api/driver/bookings/${b}/no_show`, "POST", {})).status, 200);
    assert.equal((await call(`/api/driver/bookings/${a}/no_show`, "POST", {})).status, 400, "already dropped off");
    today = (await call("/api/driver/today")).body;
    assert.equal(today.next, null);
  });
});

test("running late tells only the riders who'd be past their window", async () => {
  await withDay(async ({ call, db, setToken }) => {
    await call("/api/admin/drivers/drv1/pin", "POST", { pin: "4321" });
    setToken((await call("/api/driver/login", "POST", { phone: "8455550100", pin: "4321" })).body.token);
    const a = (await call("/api/admin/bookings", "POST", ride({ pickupMinute: 660, window: 30 }))).body.bookings[0].id;
    const b = (await call("/api/admin/bookings", "POST", ride({ pickupMinute: 780, window: 15 }))).body.bookings[0].id;
    await call(`/api/driver/bookings/${a}/accept`, "POST", {});
    await call(`/api/driver/bookings/${b}/accept`, "POST", {});
    const r = await call("/api/driver/late", "POST", { minutes: 20, key: "late1" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.told, [b]);
    assert.equal(texts(db, "late").length, 1);
    assert.equal((await call("/api/driver/late", "POST", { minutes: 0 })).status, 400);
  });
});

test("reports: waiting, on time, ride length, and driving from GPS", async () => {
  await withDay(async ({ call, setToken, at }) => {
    await call("/api/admin/drivers/drv1/pin", "POST", { pin: "4321" });
    setToken((await call("/api/driver/login", "POST", { phone: "8455550100", pin: "4321" })).body.token);
    const a = (await call("/api/admin/bookings", "POST", ride())).body.bookings[0].id;
    await call(`/api/driver/bookings/${a}/accept`, "POST", {});
    at("2026-11-11T17:20:00Z"); // 12:20, five minutes past the window
    await call(`/api/driver/bookings/${a}/pickup`, "POST", {});
    at("2026-11-11T17:35:00Z");
    await call(`/api/driver/bookings/${a}/done`, "POST", {});
    // Two minutes at about 30 mph, then a bad jump that isn't counted.
    const pts = [];
    for (let i = 0; i <= 12; i++) pts.push({ lat: 41 + i * 0.00121, lng: -74, at: new Date(Date.UTC(2026, 10, 11, 17, 20, i * 10)).toISOString() });
    pts.push({ lat: 42, lng: -74, at: new Date(Date.UTC(2026, 10, 11, 17, 22, 10)).toISOString() });
    await call("/api/driver/location", "POST", { points: pts });
    const r = (await call("/api/admin/reports?from=2026-11-11&to=2026-11-11")).body;
    assert.equal(r.averageWaitMinutes, 20);
    assert.deepEqual(r.onTimePickups, { onTime: 0, of: 1 });
    assert.equal(r.averageRideMinutes, 15);
    assert.equal(r.drivingMinutes, 2);
    assert.ok(r.miles > 0.9 && r.miles < 1.1, `miles ${r.miles}`);
  });
});

test("driving ignores long gaps and standing still", () => {
  const p = (lat, s) => ({ lat, lng: -74, at: new Date(Date.UTC(2026, 10, 11, 17, 0, s)).toISOString() });
  assert.deepEqual(driving([p(41, 0), p(41, 30), p(41, 60)]), { minutes: 0, miles: 0 });
  assert.equal(driving([p(41, 0), { ...p(41.01, 0), at: "2026-11-11T17:30:00Z" }]).miles, 0);
});
