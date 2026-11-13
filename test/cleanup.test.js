import test from "node:test";
import assert from "node:assert/strict";
import { openDb, audit } from "../src/db.js";
import { cleanupNow } from "../src/cleanup.js";
import { initAuth } from "../src/auth.js";

test("the daily cleanup removes old GPS points, logs and expired sign-ins, and keeps the recent ones", () => {
  const db = openDb(":memory:");
  initAuth(db);
  const now = new Date("2026-11-11T15:00:00Z");
  const ago = (days) => new Date(now.getTime() - days * 864e5).toISOString();
  const gps = db.prepare("INSERT INTO driver_locations (driver_id, at, lat, lng) VALUES ('d', ?, 41, -74)");
  gps.run(ago(100));
  gps.run(ago(10));
  db.prepare("INSERT INTO driver_actions (key, driver_id, at, result) VALUES ('old', 'd', ?, '{}'), ('new', 'd', ?, '{}')").run(ago(8), ago(1));
  db.prepare("INSERT INTO driver_sessions (token_hash, driver_id, expires_at) VALUES ('gone', 'd', ?), ('live', 'd', ?)").run(ago(1), ago(-1));
  db.prepare("INSERT INTO deliveries (phone, channel, kind, status, updated_at) VALUES ('+1', 'text', 'announcement', 'sent', ?), ('+1', 'text', 'announcement', 'queued', ?)").run(ago(100), ago(100));
  audit(db, "system", "kept");
  db.prepare("INSERT INTO audit (at, actor, action) VALUES (?, 'system', 'old')").run(ago(400));
  const out = cleanupNow(db, now);
  assert.equal(out.gps, 1);
  assert.equal(out.actions, 1);
  assert.equal(out.sessions, 1);
  assert.equal(out.messages, 1, "a message still waiting is kept");
  assert.equal(out.audit, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM driver_locations").get().n, 1);
  assert.equal(db.prepare("SELECT action FROM audit").get().action, "kept");
});
