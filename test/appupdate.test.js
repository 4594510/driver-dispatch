import test from "node:test";
import assert from "node:assert/strict";
import { createAppRelease } from "../src/appupdate.js";

test("the newest driver app: build number and APK link from the GitHub release, looked up every 15 minutes", async () => {
  let t = 0;
  let calls = 0;
  let answer = { ok: true, json: async () => ({ name: "Driver app (build 7)", assets: [{ name: "driver-app.apk", browser_download_url: "https://example.com/driver-app.apk" }] }) };
  const latest = createAppRelease({ fetchImpl: async () => { calls++; return answer; }, now: () => t });
  assert.equal(latest(), null, "nothing known before the first lookup");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(latest(), { version: 7, url: "https://example.com/driver-app.apk" });
  assert.equal(calls, 1);
  t += 5 * 60000;
  latest();
  assert.equal(calls, 1, "not again within 15 minutes");
  // GitHub down: what we knew stays.
  answer = { ok: false };
  t += 15 * 60000;
  assert.deepEqual(await latest.refresh(), { version: 7, url: "https://example.com/driver-app.apk" });
  // A release without an APK or a build number is ignored.
  answer = { ok: true, json: async () => ({ name: "Driver app", assets: [] }) };
  assert.equal((await latest.refresh()).version, 7);
});
