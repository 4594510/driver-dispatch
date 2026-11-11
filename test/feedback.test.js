import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";
import { openDb } from "../src/db.js";
import { feedbackKey } from "../src/feedback.js";

async function withServer(fn, env = {}) {
  const db = openDb(":memory:");
  const app = createApp(db, { ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: "first-password-1", FEEDBACK_KEY: "claude-key", ...env });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const call = async (path, method = "GET", body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  db.prepare("INSERT INTO drivers (id, name, phone) VALUES ('drv1', 'Driver', '+18455550100')").run();
  await call("/api/login", "POST", { email: "admin@example.com", password: "first-password-1" });
  try {
    await fn(call, db);
  } finally {
    server.close();
  }
}
const claude = { authorization: "Bearer claude-key" };

test("an admin sends feedback; empty or too long is refused; an unknown kind becomes a comment", async () => {
  await withServer(async (call) => {
    assert.equal((await call("/api/admin/feedback", "POST", { kind: "request", text: "  " })).status, 400);
    assert.equal((await call("/api/admin/feedback", "POST", { kind: "request", text: "x".repeat(4001) })).status, 400);
    assert.equal((await call("/api/admin/feedback", "POST", { kind: "request", text: "Add a button for X" })).status, 200);
    assert.equal((await call("/api/admin/feedback", "POST", { kind: "weird", text: "Nice" })).status, 200);
    const list = (await call("/api/admin/feedback")).body;
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((f) => f.kind).sort(), ["comment", "request"]);
    assert.ok(list.every((f) => f.status === "new" && f.source === "admin" && f.author === "admin@example.com"));
  });
});

test("Claude reads new feedback with the key, and its answer shows on the dashboard", async () => {
  await withServer(async (call) => {
    await call("/api/admin/feedback", "POST", { kind: "complaint", text: "first" });
    await call("/api/admin/feedback", "POST", { kind: "request", text: "second" });
    assert.equal((await call("/api/feedback")).status, 403, "no key");
    assert.equal((await call("/api/feedback", "GET", undefined, { authorization: "Bearer wrong" })).status, 403);
    const fresh = (await call("/api/feedback?status=new", "GET", undefined, claude)).body;
    assert.deepEqual(fresh.map((f) => f.text), ["first", "second"], "oldest first");
    assert.equal((await call(`/api/feedback/${fresh[0].id}`, "PATCH", { status: "bogus" }, claude)).status, 400);
    assert.equal((await call("/api/feedback/fb_none", "PATCH", { status: "done" }, claude)).status, 404);
    const r = await call(`/api/feedback/${fresh[0].id}`, "PATCH", { status: "needs_you", reply: "Please set X" }, claude);
    assert.equal(r.status, 200);
    assert.equal((await call("/api/feedback?status=new", "GET", undefined, claude)).body.length, 1);
    assert.equal((await call("/api/feedback?status=new,needs_you", "GET", undefined, claude)).body.length, 2);
    const shown = (await call("/api/admin/feedback")).body.find((f) => f.id === fresh[0].id);
    assert.equal(shown.status, "needs_you");
    assert.equal(shown.reply, "Please set X");
    // The admin can close it or reopen it.
    assert.equal((await call(`/api/admin/feedback/${fresh[0].id}`, "PATCH", { status: "done" })).body.feedback.status, "done");
  });
});

test("without FEEDBACK_KEY Claude's endpoint stays closed", async () => {
  await withServer(async (call) => {
    assert.equal((await call("/api/feedback", "GET", undefined, { authorization: "Bearer " })).status, 403);
    assert.equal((await call("/api/feedback", "GET", undefined, claude)).status, 403);
  }, { FEEDBACK_KEY: "" });
});

test("without FEEDBACK_KEY the key is made from the maps key, and works", async () => {
  const key = feedbackKey({ GOOGLE_MAPS_API_KEY: "maps-secret" });
  assert.ok(key.length > 30 && !key.includes("maps-secret"));
  assert.equal(feedbackKey({ FEEDBACK_KEY: "own", GOOGLE_MAPS_API_KEY: "maps-secret" }), "own");
  assert.equal(feedbackKey({}), null);
  await withServer(async (call) => {
    assert.equal((await call("/api/feedback", "GET", undefined, { authorization: `Bearer ${key}` })).status, 200);
    assert.equal((await call("/api/feedback", "GET", undefined, { authorization: "Bearer maps-secret" })).status, 403);
  }, { FEEDBACK_KEY: "", GOOGLE_MAPS_API_KEY: "maps-secret" });
});

test("the driver sends feedback from the app, once per key, and sees only their own", async () => {
  await withServer(async (call) => {
    await call("/api/admin/drivers/drv1/pin", "POST", { pin: "4321" });
    const token = (await call("/api/driver/login", "POST", { phone: "8455550100", pin: "4321" })).body.token;
    const drv = { authorization: `Bearer ${token}` };
    await call("/api/admin/feedback", "POST", { kind: "comment", text: "from the office" });
    const body = { kind: "suggestion", text: "A bigger map button", key: "k1" };
    assert.equal((await call("/api/driver/feedback", "POST", body, drv)).status, 200);
    assert.equal((await call("/api/driver/feedback", "POST", body, drv)).body.repeated, true, "sent twice without signal: saved once");
    const mine = (await call("/api/driver/feedback", "GET", undefined, drv)).body;
    assert.deepEqual(mine.map((f) => f.text), ["A bigger map button"]);
    const all = (await call("/api/feedback", "GET", undefined, claude)).body;
    assert.equal(all.length, 2);
    assert.equal(all.find((f) => f.source === "driver").author, "drv1");
  });
});
