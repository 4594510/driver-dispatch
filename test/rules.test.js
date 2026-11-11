import test from "node:test";
import assert from "node:assert/strict";
import { keypadTime, checkRequest, canChangePickup, formatMinute, localParts } from "../src/rules.js";

// 2026-11-11 11:00 AM in New York (UTC-5)
const now = new Date("2026-11-11T16:00:00Z");

test("local time is New York time", () => {
  assert.deepEqual(localParts(now), { day: "2026-11-11", minute: 11 * 60 });
});

test("keypad times: 10 and 11 are morning, 12 and 1-9 afternoon", () => {
  assert.equal(keypadTime("1015"), 10 * 60 + 15);
  assert.equal(keypadTime("0230"), 14 * 60 + 30);
  assert.equal(keypadTime("1200"), 12 * 60);
  assert.equal(keypadTime("230"), 14 * 60 + 30);
  assert.equal(keypadTime("1375"), null);
  assert.equal(formatMinute(14 * 60 + 30), "2:30 PM");
});

test("a request for now, today, inside hours is fine", () => {
  assert.deepEqual(checkRequest(now, { day: "2026-11-11", pickupMinute: null, window: 15 }).errors, []);
});

test("other days, past times, odd windows and late hours are refused", () => {
  assert.ok(checkRequest(now, { day: "2026-11-12", pickupMinute: 12 * 60, window: 15 }).errors.includes("not_today"));
  assert.ok(checkRequest(now, { day: "2026-11-11", pickupMinute: 10 * 60 + 30, window: 15 }).errors.includes("in_past"));
  assert.ok(checkRequest(now, { day: "2026-11-11", pickupMinute: 12 * 60, window: 20 }).errors.includes("bad_window"));
  assert.ok(checkRequest(now, { day: "2026-11-11", pickupMinute: 18 * 60 + 30, window: 15 }).errors.includes("outside_hours"));
});

test("return trips must be later the same day and inside hours", () => {
  assert.ok(checkRequest(now, { day: "2026-11-11", pickupMinute: 12 * 60, window: 15, returnMinute: 11 * 60 + 30 }).errors.includes("return_before_pickup"));
  assert.ok(checkRequest(now, { day: "2026-11-11", pickupMinute: 12 * 60, window: 15, returnMinute: 19 * 60 }).errors.includes("return_outside_hours"));
});

test("pickup changes are allowed only more than 30 minutes ahead", () => {
  assert.equal(canChangePickup(11 * 60, 11 * 60 + 31), true);
  assert.equal(canChangePickup(11 * 60, 11 * 60 + 30), false);
});
