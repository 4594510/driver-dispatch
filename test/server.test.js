import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";
import { openDb } from "../src/db.js";

test("admin API needs the token, then manages households and phones", async () => {
  const app = createApp(openDb(":memory:"), { ADMIN_TOKEN: "secret-token" });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  try {
    assert.equal((await fetch(`${base}/households`)).status, 401);
    const auth = { authorization: "Bearer secret-token", "content-type": "application/json" };
    const hh = await (await fetch(`${base}/households`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Family A" }) })).json();
    const ph = await fetch(`${base}/phones`, { method: "POST", headers: auth, body: JSON.stringify({ number: "+18455550001", householdId: hh.id, notify: "text" }) });
    assert.equal(ph.status, 200);
    const list = await (await fetch(`${base}/households`, { headers: auth })).json();
    assert.equal(list[0].name, "Family A");
  } finally {
    server.close();
  }
});
