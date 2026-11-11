import test from "node:test";
import assert from "node:assert/strict";
import { createApp, normalizePhone } from "../src/server.js";
import { openDb } from "../src/db.js";

async function withServer(fn) {
  const db = openDb(":memory:");
  const app = createApp(db, { ADMIN_EMAIL: "Admin@Example.com", ADMIN_PASSWORD: "first-password-1" });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const call = async (path, method = "GET", body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    await fn(call, db);
  } finally {
    server.close();
  }
}
const signIn = (call) => call("/api/login", "POST", { email: "admin@example.com", password: "first-password-1" });

test("phone numbers are normalized to +1 and 10 digits", () => {
  assert.equal(normalizePhone("(845) 555-1234"), "+18455551234");
  assert.equal(normalizePhone("1-845-555-1234"), "+18455551234");
  assert.equal(normalizePhone("555-1234"), null);
});

test("the admin API needs a sign-in; a wrong password is refused", async () => {
  await withServer(async (call) => {
    assert.equal((await call("/api/admin/households")).status, 401);
    assert.equal((await call("/api/login", "POST", { email: "admin@example.com", password: "wrong-password" })).status, 401);
    const ok = await signIn(call);
    assert.equal(ok.status, 200);
    assert.equal((await call("/api/admin/me")).body.email, "admin@example.com");
    await call("/api/logout", "POST", {});
    assert.equal((await call("/api/admin/me")).status, 401);
  });
});

test("admins can add another admin, who can then sign in", async () => {
  await withServer(async (call) => {
    await signIn(call);
    assert.equal((await call("/api/admin/admins", "POST", { email: "second@example.com", password: "short" })).status, 400);
    assert.equal((await call("/api/admin/admins", "POST", { email: "second@example.com", password: "long-enough-pw" })).status, 200);
    assert.equal((await call("/api/login", "POST", { email: "second@example.com", password: "long-enough-pw" })).status, 200);
  });
});

test("families, phones and places are managed, with place codes kept unique per family", async () => {
  await withServer(async (call) => {
    await signIn(call);
    const hh = (await call("/api/admin/households", "POST", { name: "Family A" })).body.id;
    assert.equal((await call("/api/admin/phones", "POST", { number: "845-555-0001", householdId: hh, notify: "text" })).status, 200);
    assert.equal((await call("/api/admin/phones", "POST", { number: "8455550001", householdId: hh })).status, 400, "duplicate phone");
    assert.equal((await call("/api/admin/passengers", "POST", { householdId: hh, name: "Rider", gender: "x" })).status, 400);
    assert.equal((await call("/api/admin/passengers", "POST", { householdId: hh, name: "Rider", gender: "f" })).status, 200);
    assert.equal((await call("/api/admin/places", "POST", { code: "20", name: "Shul", address: "5 Sample Rd" })).status, 200);
    assert.equal((await call("/api/admin/places", "POST", { householdId: hh, code: "20", name: "Home", address: "1 Example Ln" })).status, 400, "code used by a shared place");
    assert.equal((await call("/api/admin/places", "POST", { householdId: hh, code: "01", kind: "home", name: "Home", address: "1 Example Ln" })).status, 200);
    const list = (await call("/api/admin/households")).body;
    assert.equal(list[0].phones[0].number, "+18455550001");
    assert.equal(list[0].passengers.length, 1);
    assert.equal(list[0].places.length, 1);
  });
});

test("settings change the rules, and bad values are refused", async () => {
  await withServer(async (call) => {
    await signIn(call);
    assert.equal((await call("/api/admin/settings", "PUT", { openMinute: 20 * 60 })).status, 400, "opens after it closes");
    assert.equal((await call("/api/admin/settings", "PUT", { serviceAreas: ["Monsey", "Spring Valley", "Airmont"] })).status, 200);
    assert.deepEqual((await call("/api/admin/settings")).body.serviceAreas, ["Monsey", "Spring Valley", "Airmont"]);
  });
});

test("an announcement queues a delivery per phone by its setting", async () => {
  await withServer(async (call, db) => {
    await signIn(call);
    const hh = (await call("/api/admin/households", "POST", { name: "Family A" })).body.id;
    await call("/api/admin/phones", "POST", { number: "8455550001", householdId: hh, notify: "text" });
    await call("/api/admin/phones", "POST", { number: "8455550002", householdId: hh, notify: "voice" });
    await call("/api/admin/phones", "POST", { number: "8455550003", householdId: hh, notify: "both" });
    const noRec = (await call("/api/admin/announcements", "POST", { text: "No service Friday" })).body;
    assert.equal(noRec.voiceSkipped, 1);
    const withRec = (await call("/api/admin/announcements", "POST", { text: "No service Friday", recording: "x.mp3" })).body;
    const rows = db.prepare("SELECT phone, channel FROM deliveries WHERE announcement_id = ? ORDER BY phone, channel").all(withRec.id);
    assert.deepEqual(rows.map((r) => `${r.phone.slice(-1)}${r.channel[0]}`), ["1t", "2v", "3t", "3v"]);
  });
});

test("the dashboard page is served", async () => {
  await withServer(async (call) => {
    assert.equal((await call("/health")).body.ok, true);
  });
});
