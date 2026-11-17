import test from "node:test";
import assert from "node:assert/strict";
import "../web/driver/timetext.js";

const t = (x) => globalThis.parseTimeText(x);

test("a time typed in a free field (offering another time)", () => {
  assert.equal(t("2:35"), 14 * 60 + 35, "2 without AM/PM is the afternoon");
  assert.equal(t("235"), 14 * 60 + 35);
  assert.equal(t("2.35"), 14 * 60 + 35);
  assert.equal(t("11:10"), 11 * 60 + 10, "11 is the morning");
  assert.equal(t("10"), 10 * 60);
  assert.equal(t("12:15"), 12 * 60 + 15);
  assert.equal(t("14:30"), 14 * 60 + 30);
  assert.equal(t("1430"), 14 * 60 + 30);
  assert.equal(t("2:35 am"), 2 * 60 + 35);
  assert.equal(t("10 pm"), 22 * 60);
  assert.equal(t("12 am"), 0);
  assert.equal(t(" 3:05PM "), 15 * 60 + 5);
  for (const bad of ["", "abc", "2:75", "25:00", "13 pm", "0", "2:3", null]) assert.equal(t(bad), null, String(bad));
});
