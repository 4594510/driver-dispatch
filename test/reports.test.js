import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { report } from "../src/reports.js";

test("reports count rides by outcome and passengers carried", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hh1', 'A', 'x')").run();
  const add = db.prepare(`INSERT INTO bookings (id, day, household_id, booked_by_phone, rider_name, men, women, pickup_address,
    dropoff_address, pickup_minute, window_minutes, status, created_at, updated_at) VALUES (?, '2026-11-11', 'hh1', '+1', 'r', ?, ?, 'a', 'b', 600, 15, ?, 'x', 'x')`);
  add.run("b1", 2, 1, "completed");
  add.run("b2", 1, 0, "no_show");
  add.run("b3", 0, 2, "rejected");
  add.run("b4", 1, 0, "pending");
  const r = report(db, "2026-11-11", "2026-11-11");
  assert.equal(r.requested, 4);
  assert.equal(r.completed, 1);
  assert.equal(r.passengersTransported, 3);
  assert.equal(r.noShows, 1);
  assert.equal(r.rejected, 1);
  assert.equal(r.accepted, 2);
  assert.equal(r.pending, 1);
});
