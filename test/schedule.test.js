import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { DEFAULT_SETTINGS, checkRequest, keypadTime } from "../src/rules.js";
import { addChange, removeChange, dayHours, withDay, upcomingChanges, scheduleView } from "../src/schedule.js";
import { getSettings } from "../src/settings.js";
import { phoneStep } from "../src/phone/ivr.js";
import { dayPieces } from "../src/phone/words.js";
import { bookRide } from "../src/dispatch.js";
import { createApp } from "../src/server.js";

const now = new Date("2026-11-11T16:00:00Z"); // Wednesday 11:00 AM New York
const settings = { ...DEFAULT_SETTINGS, stopMinutes: 0 };
const travel = { geocode: async () => null, ensure: async () => {}, minutes: () => ({ minutes: 10, estimated: false }) };

function setup() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hh1', 'Family A', 'x')").run();
  db.prepare("INSERT INTO passengers (id, household_id, name, gender, spoken) VALUES ('ps1', 'hh1', 'Moshe', 'm', 'משה')").run();
  db.prepare("INSERT INTO phones (number, household_id, passenger_id, notify) VALUES ('+18455550001', 'hh1', 'ps1', 'both')").run();
  db.prepare("INSERT INTO places (id, household_id, code, kind, name, address, lat, lng, spoken) VALUES ('home', 'hh1', '01', 'home', 'Home', '1 Example Ln', 41, -74, 'שטוב')").run();
  db.prepare("INSERT INTO places (id, household_id, code, name, address, lat, lng, spoken) VALUES ('shul', NULL, '20', 'Shul', '5 Sample Rd', 41.01, -74, 'שול')").run();
  db.prepare("INSERT INTO drivers (id, name, phone, status) VALUES ('drv1', 'Driver', '+18455550100', 'online')").run();
  return db;
}
const add = (db, input) => addChange(db, input, "admin:test", settings, now);
const prompts = (r) => r.play.filter((p) => p.prompt).map((p) => p.prompt);
const said = (r) => r.play.filter((p) => p.say).map((p) => p.say);
async function call(db, steps, id = "c1") {
  const ctx = { db, travel, settings: withDay(db, settings, "2026-11-11"), now, base: "https://dispatch.example" };
  const out = [await phoneStep(ctx, { call_id: id, from: "8455550001", step: "start", keys: "" })];
  for (const keys of steps) {
    const last = out[out.length - 1];
    if (!last.gather) throw new Error(`call ended early: ${JSON.stringify(last.play)}`);
    out.push(await phoneStep(ctx, { call_id: id, from: "8455550001", step: last.gather.step, keys }));
  }
  return out;
}

test("a day's hours: the usual ones, a change for a range, the newest change counts, weekdays only", () => {
  const db = setup();
  assert.deepEqual(dayHours(db, "2026-11-12", settings), { day: "2026-11-12", closed: false, openMinute: 600, closeMinute: 1080, changed: false, changeId: null });
  assert.ok(add(db, { from: "2026-11-12", to: "2026-11-20", openMinute: 720, closeMinute: 900 }).ok);
  assert.equal(dayHours(db, "2026-11-15", settings).openMinute, 720);
  assert.ok(add(db, { from: "2026-11-15", closed: true }).ok);
  assert.equal(dayHours(db, "2026-11-15", settings).closed, true);
  assert.equal(dayHours(db, "2026-11-16", settings).openMinute, 720);
  // Every Friday (5) until 2 PM, for a month.
  assert.ok(add(db, { from: "2026-11-11", to: "2026-12-11", weekdays: [5], openMinute: 600, closeMinute: 840 }).ok);
  assert.equal(dayHours(db, "2026-11-27", settings).closeMinute, 840);
  assert.equal(dayHours(db, "2026-11-26", settings).changed, false);
  // Removing a change brings back what was under it.
  const top = dayHours(db, "2026-11-15", settings).changeId;
  assert.ok(removeChange(db, top, "admin:test").ok);
  assert.equal(dayHours(db, "2026-11-15", settings).openMinute, 720);
});

test("changes that don't make sense are refused", () => {
  const db = setup();
  assert.equal(add(db, { from: "2026-11-20", to: "2026-11-19", closed: true }).ok, false);
  assert.equal(add(db, { from: "2026-11-01", to: "2026-11-10", closed: true }).ok, false, "already passed");
  assert.equal(add(db, { from: "2026-11-20", openMinute: 900, closeMinute: 800 }).ok, false);
  assert.equal(add(db, { from: "2026-11-20" }).ok, false, "no hours");
  assert.equal(add(db, { from: "2026-02-30", closed: true }).ok, false);
  assert.equal(add(db, { from: "2026-11-16", to: "2026-11-17", weekdays: [5], closed: true }).ok, false, "no Friday in those dates");
});

test("a change shows the rides already booked outside the new hours (they stay booked)", () => {
  const db = setup();
  db.prepare(`INSERT INTO bookings (id, day, household_id, booked_by_phone, rider_name, men, women, pickup_address, dropoff_address,
    pickup_minute, window_minutes, status, created_at, updated_at) VALUES ('b1', '2026-11-11', 'hh1', '+18455550001', 'Moshe', 1, 0, 'a', 'b', 960, 15, 'accepted', 'x', 'x')`).run();
  const r = add(db, { from: "2026-11-11", openMinute: 600, closeMinute: 900 });
  assert.deepEqual(r.affected.map((b) => b.id), ["b1"]);
  assert.equal(db.prepare("SELECT status FROM bookings WHERE id = 'b1'").get().status, "accepted");
});

test("booking checks use today's hours: no rides on a closed day, and the shorter hours", async () => {
  const db = setup();
  add(db, { from: "2026-11-11", openMinute: 600, closeMinute: 780 });
  const today = getSettings(db, now);
  assert.equal(today.closeMinute, 780);
  assert.equal(today.usualCloseMinute, 1080);
  assert.ok(checkRequest(now, { day: "2026-11-11", pickupMinute: 840, window: 15 }, today).errors.includes("outside_hours"));
  add(db, { from: "2026-11-11", closed: true });
  const closed = getSettings(db, now);
  assert.ok(checkRequest(now, { day: "2026-11-11", pickupMinute: 720, window: 15 }, closed).errors.includes("closed"));
  const r = await bookRide(db, travel, { phone: "+18455550001", men: 1, women: 0, pickup: { placeId: "home" }, dropoff: { placeId: "shul" }, pickupMinute: 720, window: 15 }, now, closed);
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("closed"));
});

test("keypad times are read to fit the day's hours", () => {
  assert.equal(keypadTime("0830"), 20 * 60 + 30);
  assert.equal(keypadTime("0830", { openMinute: 480, closeMinute: 1080 }), 8 * 60 + 30);
  assert.equal(keypadTime("0230", { openMinute: 480, closeMinute: 1080 }), 14 * 60 + 30);
});

test("the next two weeks' changes, with neighbouring days put together", () => {
  const db = setup();
  add(db, { from: "2026-11-12", to: "2026-11-13", closed: true });
  add(db, { from: "2026-11-16", openMinute: 720, closeMinute: 1080 });
  add(db, { from: "2026-12-20", closed: true }); // too far ahead
  assert.deepEqual(upcomingChanges(db, settings, now), [
    { from: "2026-11-12", to: "2026-11-13", closed: true, openMinute: null, closeMinute: null },
    { from: "2026-11-16", to: "2026-11-16", closed: false, openMinute: 720, closeMinute: 1080 },
  ]);
  const v = scheduleView(db, settings, now);
  assert.equal(v.days.length, 14);
  assert.equal(v.changes.length, 3);
});

test("days are said from today: tomorrow, a weekday, or the date", () => {
  assert.deepEqual(dayPieces("2026-11-12", "2026-11-11"), ["מארגן"]);
  assert.deepEqual(dayPieces("2026-11-16", "2026-11-11"), ["מאנטאג"]);
  assert.deepEqual(dayPieces("2026-11-23", "2026-11-11"), ["מאנטאג", "נאוועמבער", "דריי און צוואנציג"]);
});

test("phone: on a closed day callers hear it at once, and can't start a booking", async () => {
  const db = setup();
  add(db, { from: "2026-11-11", closed: true });
  const r = await call(db, ["1"]);
  assert.deepEqual(prompts(r[0]), ["P01", "P49", "P04"]);
  assert.deepEqual(prompts(r[1]), ["P49", "P04"]);
});

test("phone: other hours today are said at the start; a time outside them is refused with the hours", async () => {
  const db = setup();
  add(db, { from: "2026-11-11", openMinute: 600, closeMinute: 840 });
  // 1 order, 1 for me, 1 man, 0 women, 1 from home, 2 other place, 20, 2 later, 0330 (past 2 PM)
  const r = await call(db, ["1", "1", "0", "2", "1", "2", "20", "2", "0330"]);
  assert.deepEqual(prompts(r[0]), ["P01", "P48", "P04"]);
  assert.deepEqual(said(r[0]), ["צען", "אינדערפרי", "ביז", "צוויי", "נאכמיטאג"]);
  const refused = r[r.length - 1];
  assert.deepEqual(prompts(refused), ["P48", "P16"]);
  assert.equal(refused.gather.step, "time");
});

test("phone: on a usual day the greeting is unchanged, and key 4 reads the hours and the changes coming up", async () => {
  const db = setup();
  add(db, { from: "2026-11-12", closed: true });
  add(db, { from: "2026-11-16", to: "2026-11-17", openMinute: 720, closeMinute: 1080 });
  const r = await call(db, ["4"]);
  assert.deepEqual(prompts(r[0]), ["P01", "P04"]);
  assert.deepEqual(prompts(r[1]), ["P48", "P50", "P51", "P53", "P52", "P04"]);
  assert.deepEqual(said(r[1]), [
    "צען", "אינדערפרי", "ביז", "זעקס", "נאכמיטאג", // today
    "צען", "אינדערפרי", "ביז", "זעקס", "נאכמיטאג", // usually
    "מארגן", // tomorrow: no rides
    "פון", "מאנטאג", "ביז", "דינסטאג", "צוועלף", "נאכמיטאג", "ביז", "זעקס", "נאכמיטאג",
  ]);
});

test("the admin and the driver app set and remove schedule changes", async () => {
  const db = openDb(":memory:");
  const clock = () => now;
  const app = createApp(db, { ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: "first-password-1" }, { travel, now: clock });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  let token = "";
  const req = async (path, method = "GET", body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, body: await res.json() };
  };
  try {
    await req("/api/login", "POST", { email: "admin@example.com", password: "first-password-1" });
    const a = await req("/api/admin/schedule", "POST", { from: "2026-11-12", to: "2026-11-14", closed: true, note: "Away" });
    assert.equal(a.status, 200);
    assert.equal((await req("/api/admin/schedule", "POST", { from: "2026-11-12", openMinute: 900, closeMinute: 800 })).status, 400);
    const view = (await req("/api/admin/schedule")).body;
    assert.equal(view.changes.length, 1);
    assert.equal(view.days[1].closed, true);

    db.prepare("INSERT INTO drivers (id, name, phone) VALUES ('drv1', 'Driver', '+18455550100')").run();
    await req("/api/admin/drivers/drv1/pin", "POST", { pin: "4321" });
    token = (await req("/api/driver/login", "POST", { phone: "845-555-0100", pin: "4321" })).body.token;
    const d = await req("/api/driver/schedule", "POST", { from: "2026-11-11", openMinute: 600, closeMinute: 720, key: "k1" });
    assert.equal(d.status, 200);
    assert.equal((await req("/api/driver/today")).body.hours.closeMinute, 720);
    assert.equal(db.prepare("SELECT actor FROM audit WHERE action = 'schedule_changed' ORDER BY id DESC").get().actor, "driver:drv1");
    assert.equal((await req(`/api/driver/schedule/${a.body.change.id}/remove`, "POST", { key: "k2" })).status, 200);
    assert.equal((await req("/api/driver/schedule")).body.changes.length, 1);
  } finally {
    server.close();
  }
});
