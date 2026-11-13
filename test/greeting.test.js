import test from "node:test";
import assert from "node:assert/strict";
import { greetingPrompt, farewellPrompt } from "../src/phone/greeting.js";

// Times are New York local (UTC-5 in winter, UTC-4 in summer).
const at = (iso) => greetingPrompt(new Date(iso));

test("the greeting goes by the time of day, Shabbos, and the Jewish day (Shloime, 2026-11-13)", () => {
  assert.equal(at("2026-11-12T15:00:00Z"), "P72", "Thursday 10 AM: good morning");
  assert.equal(at("2026-11-12T18:00:00Z"), "P73", "1 PM: good day");
  assert.equal(at("2026-11-12T22:30:00Z"), "P74", "5:30 PM: good evening");
  assert.equal(at("2026-11-13T15:00:00Z"), "P82", "Friday: a good erev Shabbos");
  assert.equal(at("2026-11-15T01:00:00Z"), "P75", "Saturday night: a good week");
  assert.equal(at("2026-11-15T15:00:00Z"), "P72", "Sunday is a usual day");
  assert.equal(at("2026-11-10T15:00:00Z"), "P76", "30 Cheshvan: Rosh Chodesh");
  assert.equal(at("2026-11-11T15:00:00Z"), "P76", "1 Kislev: Rosh Chodesh");
  assert.equal(at("2026-12-05T15:00:00Z"), "P78", "25 Kislev: Chanukah");
  assert.equal(at("2026-12-12T15:00:00Z"), "P78", "2 Teves: the last day of Chanukah");
  assert.equal(at("2026-12-14T15:00:00Z"), "P72", "4 Teves: Chanukah is over");
  assert.equal(at("2027-03-23T14:00:00Z"), "P79", "14 Adar II: Purim");
  assert.equal(at("2027-04-21T14:00:00Z"), "P83", "14 Nisan: erev Pesach");
  assert.equal(at("2027-04-25T14:00:00Z"), "P77", "18 Nisan: Chol Hamoed");
  assert.equal(at("2027-05-25T14:00:00Z"), "P72", "18 Iyar (10 AM): no Lag Baomer greeting");
  assert.equal(at("2027-09-14T14:00:00Z"), "P72", "Elul (10 AM): a usual greeting");
});

test("the goodbye wishes a kesiva vachasima tova in Elul and a gmar chasima tova until Yom Kippur", () => {
  assert.equal(farewellPrompt(new Date("2027-09-14T14:00:00Z")), "P80", "12 Elul");
  assert.equal(farewellPrompt(new Date("2027-10-05T14:00:00Z")), "P81", "4 Tishrei");
  assert.equal(farewellPrompt(new Date("2026-11-12T14:00:00Z")), "P41");
});
