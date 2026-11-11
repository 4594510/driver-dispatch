import test from "node:test";
import assert from "node:assert/strict";
import { createApp, normalizePhone } from "../src/server.js";
import { openDb } from "../src/db.js";
import { webhookAllowed, readStep, toActions } from "../src/phone/fonory.js";

async function withServer(fn, deps = {}) {
  const db = openDb(":memory:");
  const app = createApp(db, { ADMIN_EMAIL: "Admin@Example.com", ADMIN_PASSWORD: "first-password-1", FONORY_WEBHOOK_KEY: "hook-secret", PUBLIC_URL: "https://dispatch.example" }, deps);
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

test("a phone belongs to a whole family or to one person in it", async () => {
  await withServer(async (call) => {
    await signIn(call);
    const hh = (await call("/api/admin/households", "POST", { name: "Family A" })).body.id;
    const other = (await call("/api/admin/households", "POST", { name: "Family B" })).body.id;
    const ps = (await call("/api/admin/passengers", "POST", { householdId: hh, name: "Rider", gender: "m" })).body.id;
    const stranger = (await call("/api/admin/passengers", "POST", { householdId: other, name: "Other", gender: "m" })).body.id;
    assert.equal((await call("/api/admin/phones", "POST", { number: "8455550002", householdId: hh, passengerId: stranger })).status, 400, "person from another family");
    assert.equal((await call("/api/admin/phones", "POST", { number: "8455550002", householdId: hh, passengerId: ps })).status, 200);
    assert.equal((await call("/api/admin/phones", "POST", { number: "8455550003", householdId: hh, passengerId: "" })).status, 200);
    let phones = (await call("/api/admin/households")).body.find((h) => h.id === hh).phones;
    assert.equal(phones.find((p) => p.number === "+18455550002").passenger_id, ps);
    assert.equal(phones.find((p) => p.number === "+18455550003").passenger_id, null);
    // Move a phone to the person, then back to the family; changing only the message setting keeps the owner.
    assert.equal((await call("/api/admin/phones/%2B18455550003", "PATCH", { passengerId: ps })).status, 200);
    assert.equal((await call("/api/admin/phones/%2B18455550003", "PATCH", { notify: "text" })).status, 200);
    assert.equal((await call("/api/admin/phones/%2B18455550003", "PATCH", { passengerId: stranger })).status, 400);
    phones = (await call("/api/admin/households")).body.find((h) => h.id === hh).phones;
    assert.deepEqual([phones.find((p) => p.number === "+18455550003").passenger_id, phones.find((p) => p.number === "+18455550003").notify], [ps, "text"]);
    // Removing the person keeps their phone, now for the whole family.
    await call(`/api/admin/passengers/${ps}`, "DELETE");
    phones = (await call("/api/admin/households")).body.find((h) => h.id === hh).phones;
    assert.equal(phones.length, 2);
    assert.ok(phones.every((p) => p.passenger_id === null));
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
    // Without a recording the call reads the text in the Yiddish voice.
    assert.equal(db.prepare("SELECT count(*) AS n FROM deliveries WHERE announcement_id = ? AND channel = 'voice'").get(noRec.id).n, 2);
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

test("booking, preview, accept and cancel through the API keep the day's route", async () => {
  const travel = {
    geocode: async (a) => ({ "1 example ln": { lat: 41, lng: -74 }, "5 sample rd": { lat: 51, lng: -74 } })[a.toLowerCase()] || null,
    ensure: async () => {},
    minutes: (a, b) => ({ minutes: a && b ? Math.abs(Number(a.split(",")[0]) - Number(b.split(",")[0])) : 15, estimated: !(a && b) }),
  };
  const now = () => new Date("2026-11-11T15:00:00Z");
  await withServer(async (call, db) => {
    await signIn(call);
    db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hh1', 'Family A', 'x')").run();
    db.prepare("INSERT INTO phones (number, household_id) VALUES ('+18455550001', 'hh1')").run();
    db.prepare("INSERT INTO drivers (id, name, phone) VALUES ('drv1', 'Driver', '+18455550100')").run();
    const ride = { phone: "845-555-0001", riderName: "Test", men: 1, women: 0, pickup: { address: "1 Example Ln" }, dropoff: { address: "5 Sample Rd" }, pickupMinute: 720, window: 15 };
    const made = await call("/api/admin/bookings", "POST", ride);
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const id = made.body.bookings[0].id;
    const preview = await call(`/api/admin/bookings/${id}/preview`);
    assert.equal(preview.body.eta, 720);
    assert.equal(preview.body.before.stops.length, 0);
    assert.equal((await call(`/api/admin/bookings/${id}/accept`, "POST", {})).status, 200);
    const route = (await call("/api/admin/route?day=2026-11-11")).body;
    assert.deepEqual(route.stops.map((s) => [s.kind, s.arrive]), [["pickup", 720], ["dropoff", 732]]);
    assert.equal((await call(`/api/admin/bookings/${id}/cancel`, "POST", {})).status, 200);
    assert.equal((await call("/api/admin/route?day=2026-11-11")).body.stops.length, 0);
  }, { travel, now });
});

test("the phone line speaks Teltech's format: key first, then { actions } for each step", async () => {
  await withServer(async (call, db) => {
    db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hh1', 'Family A', 'x')").run();
    db.prepare("INSERT INTO phones (number, household_id) VALUES ('+18455550001', 'hh1')").run();
    const first = { event: "new_call", call_id: "c1", caller_id: "18455550001", did: "18457315290", extension: "18457315290/", timestamp: 1, variables: {} };
    assert.equal((await call("/fonory/step", "POST", first)).status, 403);
    assert.equal((await call("/fonory/step?key=wrong", "POST", first)).status, 403);
    const r = await call("/fonory/step?key=hook-secret", "POST", first);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.actions, [
      { action: "play", file: "https://dispatch.example/prompts/P01.wav" },
      { action: "play", file: "https://dispatch.example/prompts/P04.wav" },
      { action: "gather", max_digits: 1, timeout: 6000, tries: 1, action_url: "https://dispatch.example/fonory/step?step=menu" },
    ]);
    const unknown = await call("/fonory/step?key=hook-secret", "POST", { ...first, call_id: "c2", caller_id: "18455559999" });
    assert.deepEqual(unknown.body.actions, [{ action: "play", file: "https://dispatch.example/prompts/P02.wav" }, { action: "hangup" }]);
    const status = await call("/fonory/status?key=hook-secret", "POST", { call_id: "c1", status: "completed" });
    assert.equal(status.status, 200);
    assert.equal((await call("/audio/../data.db")).status, 404);
  });
});

test("Teltech's requests and our answers translate both ways", () => {
  const req = (query, body) => ({ query, body });
  assert.deepEqual(readStep(req({}, { event: "new_call", call_id: "c", caller_id: "18455550142", digits: "" })),
    { call_id: "c", from: "18455550142", direction: "inbound", step: "start", keys: "" });
  assert.deepEqual(readStep(req({ step: "time" }, { event: "gather", call_id: "c", caller_id: "18455550142", digits: "0230" })),
    { call_id: "c", from: "18455550142", direction: "inbound", step: "time", keys: "0230" });
  assert.equal(readStep(req({}, { event: "outbound_answered", call_id: "o", caller_id: "1845", start: "out:7" })).step, "out:7");
  assert.equal(readStep(req({}, { event: "outbound_answered", call_id: "o", caller_id: "1845", start: "out:7" })).direction, "outbound");
  const base = "https://d.example";
  assert.deepEqual(toActions({ play: [{ prompt: "P19" }, { audio: `${base}/audio/clips/ab.wav` }, { say: "צוויי" }], gather: { step: "time", max_keys: 4, timeout_s: 6 } }, base, {}).actions, [
    { action: "play", file: `${base}/prompts/P19.wav` },
    { action: "play", file: `${base}/audio/clips/ab.wav` },
    { action: "say", text: "צוויי", language: "yiddish" },
    { action: "gather", max_digits: 4, timeout: 6000, tries: 1, terminator: "#", action_url: `${base}/fonory/step?step=time` },
  ]);
  assert.deepEqual(toActions({ play: [{ prompt: "P41" }], hangup: true }, base, { FONORY_PROMPTS: "uploaded" }).actions,
    [{ action: "play", file: "P41.wav" }, { action: "hangup" }]);
});

test("every prompt in the script has its 8 kHz recording in prompts/", async () => {
  const fs = await import("node:fs");
  const { PROMPTS } = await import("../src/phone/words.js");
  for (const code of Object.keys(PROMPTS)) {
    const wav = fs.readFileSync(new URL(`../prompts/${code}.wav`, import.meta.url));
    assert.equal(wav.readUInt32LE(24), 8000, `${code} sample rate`);
    assert.equal(wav.readUInt16LE(22), 1, `${code} mono`);
  }
});

test("the phone line needs Teltech's key, and their address when one is set", () => {
  const req = (ip, key) => ({ ip, query: key ? { key } : {}, get: () => undefined });
  const env = { FONORY_WEBHOOK_KEY: "hook-secret", FONORY_ALLOWED_IPS: "178.156.145.236, 10.0.0.9" };
  assert.equal(webhookAllowed(req("178.156.145.236", "hook-secret"), env), true);
  assert.equal(webhookAllowed(req("::ffff:178.156.145.236", "hook-secret"), env), true);
  assert.equal(webhookAllowed(req("10.0.0.9", "hook-secret"), env), true);
  assert.equal(webhookAllowed(req("178.156.145.236"), env), false, "right address, no key");
  assert.equal(webhookAllowed(req("178.156.145.236", "wrong"), env), false, "right address, wrong key");
  assert.equal(webhookAllowed(req("203.0.113.5", "hook-secret"), env), false, "right key, other address");
  assert.equal(webhookAllowed(req("203.0.113.5", "hook-secret"), { FONORY_WEBHOOK_KEY: "hook-secret" }), true, "no list: key only");
  assert.equal(webhookAllowed(req("178.156.145.236"), { FONORY_ALLOWED_IPS: "178.156.145.236" }), false, "no key set: nothing gets in");
});
