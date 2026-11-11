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

test("Teltech's collect: our listen step becomes a voice collect with a transcript, and the transcript is read back", () => {
  const out = toActions({ play: [{ prompt: "P56" }], listen: { step: "from_say", max_s: 20 } }, "https://d.example", {});
  const collect = out.actions.at(-1);
  assert.equal(collect.action, "collect");
  assert.equal(collect.type, "voice");
  assert.equal(collect.transcribe, true);
  assert.equal(collect.transcribe_language, "en");
  assert.equal(collect.action_url, "https://d.example/fonory/step?step=from_say");
  assert.equal(out.actions.some((a) => a.action === "hangup"), false);
  const step = readStep({ query: { step: "from_say" }, body: { event: "collect", call_id: "c", caller_id: "18455550001", field_id: "address", field_transcript: "12 Main Street Monsey" } });
  assert.equal(step.transcript, "12 Main Street Monsey");
  assert.equal(step.step, "from_say");
  const english = toActions({ play: [{ say: "12 Main Street, Monsey", language: "english" }], hangup: true }, "https://d.example", {});
  assert.equal(english.actions[0].language, "english");
});

test("adding a place: the code is the house number when free, any 1 to 6 digits, unique for everyone; the map checks it", async () => {
  const lookup = async (a) => /nowhere/i.test(a) ? { status: "not_found" }
    : /^main st/i.test(a) ? { status: "found", lat: 41.1, lng: -74.05, formatted: "Main St, Monsey, NY 10952, USA", exact: false }
    : /boston/i.test(a) ? { status: "found", lat: 42.36, lng: -71.06, formatted: "Boston, MA, USA", exact: false, km: 290 }
    : { status: "found", lat: 41.11, lng: -74.07, formatted: "12 Main St, Monsey, NY 10952, USA", exact: true };
  await withServer(async (call, db) => {
    await signIn(call);
    const hh = (await call("/api/admin/households", "POST", { name: "Family" })).body.id;
    const hh2 = (await call("/api/admin/households", "POST", { name: "Other family" })).body.id;
    const a = await call("/api/admin/places", "POST", { householdId: hh, kind: "home", name: "Home", address: "12 Main St Monsey" });
    assert.equal(a.status, 200);
    assert.equal(a.body.code, "12", "empty code = the house number");
    assert.equal(a.body.found, "12 Main St, Monsey, NY 10952, USA");
    assert.equal(a.body.warning, null);
    assert.equal(db.prepare("SELECT lat FROM places WHERE id = ?").get(a.body.id).lat, 41.11, "the map point is kept");
    assert.equal((await call("/api/admin/places", "POST", { householdId: hh2, name: "Work", address: "12 Main St" })).body.code, "01", "house number taken: the next free code");
    assert.equal((await call("/api/admin/places", "POST", { householdId: hh, code: "3", name: "Work", address: "12 Main St" })).body.code, "03");
    assert.equal((await call("/api/admin/places", "POST", { householdId: hh, code: "045", name: "Park", address: "12 Main St" })).body.code, "45");
    assert.equal((await call("/api/admin/places", "POST", { householdId: hh, code: "1234", name: "Shop", address: "12 Main St" })).body.code, "1234");
    assert.equal((await call("/api/admin/places", "POST", { householdId: hh, code: "1234567", name: "X", address: "12 Main St" })).status, 400, "at most 6 digits");
    assert.match((await call("/api/admin/places", "POST", { code: "100", name: "X", address: "12 Main St" })).body.error, /100 = say a new address/);
    const taken = await call("/api/admin/places", "POST", { householdId: hh2, code: "12", name: "X", address: "12 Main St" });
    assert.equal(taken.status, 400, "codes are shared by every family");
    assert.match(taken.body.error, /already used by Home\. Code 02 is free/);
    const missing = await call("/api/admin/places", "POST", { householdId: hh, name: "X", address: "Nowhere Road 99" });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /can't find/);
    assert.match((await call("/api/admin/places", "POST", { householdId: hh, name: "Street", address: "Main St" })).body.warning, /house number/);
    assert.match((await call("/api/admin/places", "POST", { householdId: hh, name: "Far", address: "Boston" })).body.warning, /miles from Monsey/);
    assert.equal((await call(`/api/admin/places/${a.body.id}`, "PATCH", { address: "Nowhere 1" })).status, 400, "an edit is checked too");
    assert.equal((await call(`/api/admin/places/${a.body.id}`, "PATCH", { address: "14 Main St Monsey" })).status, 200);
  }, { travel: { geocode: async () => null, ensure: async () => {}, minutes: () => ({ minutes: 10, estimated: false }), lookup } });
});

test("Shloime's list of places is added once, shared, with its own codes; a family place in the way moves", async () => {
  const { addPlaceLists, PLACE_LISTS } = await import("../src/seed.js");
  const db = openDb(":memory:");
  db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hh1', 'A', 'x')").run();
  db.prepare("INSERT INTO places (id, household_id, code, kind, name, address) VALUES ('home', 'hh1', '01', 'home', 'Home', '33 Elm St')").run();
  const log = [];
  addPlaceLists(db, PLACE_LISTS, (m) => log.push(m));
  const byCode = (c) => db.prepare("SELECT * FROM places WHERE code = ? AND active = 1").get(c);
  assert.equal(byCode("01").name, "Satmer");
  assert.equal(byCode("01").household_id, null);
  assert.equal(byCode("401").name, "Atrium");
  assert.equal(byCode("108").address, "108 Route 306, Monsey, NY 10952");
  assert.equal(db.prepare("SELECT code FROM places WHERE id = 'home'").get().code, "33", "the family's home moved to its house number");
  assert.equal(db.prepare("SELECT count(*) AS n FROM places WHERE household_id IS NULL").get().n, PLACE_LISTS["places-2026-11-11"].length);
  db.prepare("UPDATE places SET active = 0 WHERE code = '18'").run();
  addPlaceLists(db, PLACE_LISTS, () => {});
  assert.ok(!byCode("18"), "a place removed later does not come back");
});

test("without a map key a place is saved unchecked", async () => {
  await withServer(async (call) => {
    await signIn(call);
    const r = await call("/api/admin/places", "POST", { name: "Shul", address: "anything" });
    assert.equal(r.status, 200);
    assert.equal(r.body.code, "01");
  });
});

test("a ride booked from the dashboard with a typed one-time address: checked on the map, not saved as a place", async () => {
  const travel = {
    geocode: async () => null, ensure: async () => {}, minutes: () => ({ minutes: 10, estimated: false }),
    lookup: async (a) => /nowhere/i.test(a) ? { status: "not_found" } : { status: "found", lat: 41.12, lng: -74.06, formatted: a, exact: true },
  };
  await withServer(async (call, db) => {
    await signIn(call);
    db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hh1', 'Family A', 'x')").run();
    db.prepare("INSERT INTO phones (number, household_id) VALUES ('+18455550001', 'hh1')").run();
    const ride = { phone: "845-555-0001", men: 1, women: 0, pickup: { address: "Nowhere 9" }, dropoff: { address: "5 Sample Rd" }, pickupMinute: 720, window: 15 };
    const bad = await call("/api/admin/bookings", "POST", ride);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /can't find "Nowhere 9"/);
    const ok = await call("/api/admin/bookings", "POST", { ...ride, pickup: { address: "9 Maple Ave" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const b = db.prepare("SELECT * FROM bookings").get();
    assert.equal(b.pickup_address, "9 Maple Ave");
    assert.equal(b.pickup_lat, 41.12);
    assert.equal(db.prepare("SELECT count(*) AS n FROM places").get().n, 0);
  }, { travel, now: () => new Date("2026-11-11T15:00:00Z") });
});

test("relations and seat rules are added, listed and removed; a phone's people include relatives", async () => {
  await withServer(async (call, db) => {
    await signIn(call);
    db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hh1', 'A', 'x'), ('hh2', 'B', 'x')").run();
    db.prepare("INSERT INTO passengers (id, household_id, name, gender) VALUES ('p1', 'hh1', 'Moshe', 'm'), ('p2', 'hh2', 'Bubby', 'f')").run();
    db.prepare("INSERT INTO phones (number, household_id) VALUES ('+18455550001', 'hh1')").run();
    assert.equal((await call("/api/admin/relations", "POST", { aId: "p1", bId: "p1", kind: "spouse" })).status, 400);
    const r = await call("/api/admin/relations", "POST", { aId: "p2", bId: "p1", kind: "grandparent", seating: "together" });
    assert.equal(r.status, 200);
    const list = (await call("/api/admin/relations")).body;
    assert.equal(list.relations[0].seating_label, "May sit next to each other");
    assert.ok(list.kinds.spouse && list.seating.apart);
    const people = (await call("/api/admin/phones/8455550001/people")).body;
    assert.deepEqual(people.map((p) => p.name), ["Moshe", "Bubby"]);
    assert.equal((await call(`/api/admin/relations/${r.body.id}`, "DELETE")).status, 200);
    assert.equal((await call("/api/admin/relations")).body.relations.length, 0);
  });
});
