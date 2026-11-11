import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createTravel, pointKey, estimateMinutes } from "../src/travel.js";

const A = pointKey(41.11, -74.04);
const B = pointKey(41.12, -74.05);

function fakeFetch() {
  const seen = [];
  const fn = async (url, init) => {
    seen.push({ url, init });
    if (url.includes("geocode")) {
      return { ok: true, json: async () => ({ status: "OK", results: [{ geometry: { location: { lat: 41.11, lng: -74.04 } } }] }) };
    }
    const body = JSON.parse(init.body);
    const out = [];
    body.origins.forEach((_, i) => body.destinations.forEach((_, j) => out.push({ originIndex: i, destinationIndex: j, duration: `${(i + j + 1) * 300}s`, distanceMeters: 1000, condition: "ROUTE_EXISTS" })));
    return { ok: true, json: async () => out };
  };
  fn.seen = seen;
  return fn;
}

test("geocoding is cached by address", async () => {
  const db = openDb(":memory:");
  const fetch = fakeFetch();
  const t = createTravel(db, { apiKey: "k", fetch });
  assert.deepEqual(await t.geocode("1 Example Ln"), { lat: 41.11, lng: -74.04 });
  assert.deepEqual(await t.geocode(" 1 example  LN "), { lat: 41.11, lng: -74.04 });
  assert.equal(fetch.seen.length, 1);
});

test("travel times come from the route matrix with traffic, cached per hour", async () => {
  const db = openDb(":memory:");
  const fetch = fakeFetch();
  const now = () => new Date("2026-11-11T15:00:00Z");
  const t = createTravel(db, { apiKey: "k", fetch, now });
  await t.ensure([{ a: A, b: B, minute: 12 * 60 }, { a: B, b: A, minute: 12 * 60 + 10 }]);
  assert.equal(fetch.seen.length, 1);
  const req = JSON.parse(fetch.seen[0].init.body);
  assert.equal(req.routingPreference, "TRAFFIC_AWARE");
  assert.equal(req.departureTime, "2026-11-11T17:30:00.000Z"); // 12:30 PM New York, the hour's middle
  assert.equal(fetch.seen[0].init.headers["X-Goog-Api-Key"], "k");
  assert.deepEqual(t.minutes(A, B, 12 * 60 + 40), { minutes: 5, estimated: false });
  // Another hour falls back to the nearest one we have, then gets its own once fetched.
  assert.equal(t.minutes(A, B, 15 * 60).estimated, false);
  await t.ensure([{ a: A, b: B, minute: 12 * 60 + 30 }]);
  assert.equal(fetch.seen.length, 1);
});

test("without traffic one bucket covers every hour; without a key it's an estimate", async () => {
  const db = openDb(":memory:");
  const fetch = fakeFetch();
  const t = createTravel(db, { apiKey: "k", fetch, traffic: false });
  await t.ensure([{ a: A, b: B, minute: 600 }, { a: A, b: B, minute: 900 }]);
  assert.equal(fetch.seen.length, 1);
  assert.equal(JSON.parse(fetch.seen[0].init.body).routingPreference, "TRAFFIC_UNAWARE");
  const none = createTravel(openDb(":memory:"), {});
  assert.deepEqual(none.minutes(A, B, 600), { minutes: estimateMinutes(A, B), estimated: true });
  assert.equal(await none.geocode("1 Example Ln"), null);
});

test("Google failing is logged, never thrown", async () => {
  const db = openDb(":memory:");
  const logs = [];
  const t = createTravel(db, { apiKey: "k", fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "API not enabled" } }) }), log: (...a) => logs.push(a.join(" ")) });
  await t.ensure([{ a: A, b: B, minute: 600 }]);
  assert.equal(t.minutes(A, B, 600).estimated, true);
  assert.match(logs[0], /API not enabled/);
});
