import test from "node:test";
import assert from "node:assert/strict";
import { greetingPrompt, farewellPrompts } from "../src/phone/greeting.js";

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

test("Chol Hamoed, also Hoshana Rabba and erev the last days of Pesach, greets with a gutn moed (Shloime, 2026-11-15)", () => {
  assert.equal(at("2027-10-15T14:00:00Z"), "P83", "14 Tishri: erev Sukkos");
  assert.equal(at("2027-10-21T14:00:00Z"), "P77", "20 Tishri: Chol Hamoed");
  assert.equal(at("2027-10-22T14:00:00Z"), "P77", "21 Tishri, a Friday: Hoshana Rabba is Chol Hamoed, not erev Yom Tov or erev Shabbos");
  assert.equal(at("2027-04-27T14:00:00Z"), "P77", "20 Nisan: erev the last days, still Chol Hamoed");
});

test("the goodbye: yasher koach, the wish of the day, then the season's (Shloime, 2026-11-15)", () => {
  const bye = (iso) => farewellPrompts(new Date(iso));
  assert.deepEqual(bye("2026-11-12T15:00:00Z"), ["P86", "P73"], "Thursday 10 AM: a gutn tog");
  assert.deepEqual(bye("2026-11-12T23:00:00Z"), ["P86", "P87"], "6 PM: a gute nacht");
  assert.deepEqual(bye("2026-11-13T15:00:00Z"), ["P86", "P88"], "Friday: a gut Shabbos");
  assert.deepEqual(bye("2026-11-15T01:00:00Z"), ["P86", "P75"], "motzei Shabbos: a gute voch");
  assert.deepEqual(bye("2026-11-15T15:00:00Z"), ["P86", "P73"], "Sunday: no gute voch");
  assert.deepEqual(bye("2027-04-21T14:00:00Z"), ["P86", "P89"], "erev Pesach: a gut yom tov");
  assert.deepEqual(bye("2027-04-25T14:00:00Z"), ["P86", "P77"], "Chol Hamoed: a gutn moed");
  assert.deepEqual(bye("2027-04-27T14:00:00Z"), ["P86", "P89"], "20 Nisan: erev the last days");
  assert.deepEqual(bye("2026-12-07T15:00:00Z"), ["P86", "P78"], "Chanukah");
  assert.deepEqual(bye("2027-08-17T14:00:00Z"), ["P86", "P73"], "14 Av: nothing for the season yet");
  assert.deepEqual(bye("2027-08-18T14:00:00Z"), ["P86", "P73", "P80", "P90"], "15 Av: kesiva vachasima, a gut gebentsht yor");
  assert.deepEqual(bye("2027-10-01T14:00:00Z"), ["P86", "P89", "P80", "P90"], "29 Elul, erev Rosh Hashana");
  assert.deepEqual(bye("2027-10-11T14:00:00Z"), ["P86", "P73", "P81"], "10 Tishri: gmar chasima tova");
  assert.deepEqual(bye("2027-10-12T14:00:00Z"), ["P86", "P73", "P84"], "11 Tishri: gmar chosem chaim");
  assert.deepEqual(bye("2027-10-22T14:00:00Z"), ["P86", "P89", "P85"], "Hoshana Rabba (a Friday): a gut yom tov, a gut kvitel");
  assert.deepEqual(bye("2027-10-28T14:00:00Z"), ["P86", "P73"], "27 Tishri");
});
