import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { phoneStep } from "../src/phone/ivr.js";
import { numberWords, timePieces, PROMPTS } from "../src/phone/words.js";
import { notifyBooking, queueReminders, sendDue, callEnded } from "../src/notify.js";
import { makeWanted } from "../src/phone/audio.js";
import { getBooking } from "../src/bookings.js";
import { acceptRide } from "../src/dispatch.js";
import { DEFAULT_SETTINGS } from "../src/rules.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const now = new Date("2026-11-11T15:00:00Z"); // 10:00 AM New York
const settings = { ...DEFAULT_SETTINGS, stopMinutes: 0 };
const travel = {
  geocode: async () => null,
  ensure: async () => {},
  minutes: (a, b) => ({ minutes: a && b ? Math.abs(Number(a.split(",")[0]) - Number(b.split(",")[0])) : 10, estimated: false }),
};

function setup() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hh1', 'Family A', 'x')").run();
  db.prepare("INSERT INTO passengers (id, household_id, name, gender, spoken) VALUES ('ps1', 'hh1', 'Moshe', 'm', 'משה')").run();
  db.prepare("INSERT INTO passengers (id, household_id, name, gender, spoken) VALUES ('ps2', 'hh1', 'Rivka', 'f', 'רבקה')").run();
  db.prepare("INSERT INTO phones (number, household_id, passenger_id, notify) VALUES ('+18455550001', 'hh1', 'ps1', 'both')").run();
  db.prepare("INSERT INTO places (id, household_id, code, kind, name, address, lat, lng, spoken) VALUES ('home', 'hh1', '01', 'home', 'Home', '1 Example Ln', 41, -74, 'שטוב')").run();
  db.prepare("INSERT INTO places (id, household_id, code, name, address, lat, lng, spoken) VALUES ('shul', NULL, '20', 'Shul', '5 Sample Rd', 51, -74, 'שול')").run();
  db.prepare("INSERT INTO drivers (id, name, phone, status) VALUES ('drv1', 'Driver', '+18455550100', 'online')").run();
  return db;
}
const ctx = (db, extra = {}) => ({ db, travel, settings, now, base: "https://dispatch.example", ...extra });
// Walk a call through steps: [[keys]] after the start; returns every answer.
async function call(db, steps, { from = "8455550001", id = "c1", extra = {} } = {}) {
  const out = [await phoneStep(ctx(db, extra), { call_id: id, from, direction: "inbound", step: "start", keys: "" })];
  for (const keys of steps) {
    const last = out[out.length - 1];
    if (!last.gather) throw new Error(`call ended early after ${out.length - 1} keys: ${JSON.stringify(last.play)}`);
    out.push(await phoneStep(ctx(db, extra), { call_id: id, from, step: last.gather.step, keys }));
  }
  return out;
}
const prompts = (r) => r.play.filter((p) => p.prompt).map((p) => p.prompt);
const said = (r) => r.play.filter((p) => p.say).map((p) => p.say);

test("Yiddish numbers and times", () => {
  assert.equal(numberWords(7), "זיבן");
  assert.equal(numberWords(21), "איין און צוואנציג");
  assert.equal(numberWords(45), "פינף און פערציג");
  assert.deepEqual(timePieces(14 * 60 + 30), ["צוויי", "דרייסיג", "נאכמיטאג"]);
  assert.deepEqual(timePieces(10 * 60 + 5), ["צען", "נול", "פינף", "אינדערפרי"]);
  assert.deepEqual(timePieces(12 * 60), ["צוועלף", "נאכמיטאג"]);
  assert.ok(Object.keys(PROMPTS).length >= 48);
});

test("an unregistered number hears P02 and the call ends", async () => {
  const db = setup();
  const r = await phoneStep(ctx(db), { call_id: "x", from: "+18455559999", step: "start", keys: "" });
  assert.deepEqual(prompts(r), ["P02"]);
  assert.equal(r.hangup, true);
});

test("booking a ride by phone the short way: from, to, when, and it's read back", async () => {
  const db = setup();
  const sent = [];
  // 1 order, 1 for myself (Moshe's own phone: no names), 0 from home, code 20 to the shul, 2 later, 1200, 1 correct.
  const r = await call(db, ["1", "1", "0", "20", "2", "1200", "1"], { extra: { notify: (b, k) => sent.push(k) } });
  assert.deepEqual(prompts(r[0]), ["P01", "P04"]);
  assert.deepEqual(prompts(r[1]), ["P06"]);
  assert.deepEqual(prompts(r[2]), ["P11"]);
  assert.equal(r[2].gather.max_keys, 6, "a place code is typed right away");
  assert.deepEqual(prompts(r[3]), ["P12"]);
  assert.deepEqual(prompts(r[6]), ["P19", "P20"], "no ride-back question: straight to the read-back");
  assert.deepEqual(said(r[6]), ["משה", "פון", "שטוב", "קיין", "שול", "אום", "צוועלף", "נאכמיטאג"]);
  const done = r[7];
  assert.deepEqual(prompts(done), ["P21", "P41"]);
  assert.equal(done.hangup, true);
  const b = db.prepare("SELECT * FROM bookings").get();
  assert.equal(b.passenger_id, "ps1");
  assert.equal(b.men, 1);
  assert.equal(b.women, 0);
  assert.equal(b.pickup_minute, 720);
  assert.equal(b.status, "pending");
  assert.equal(db.prepare("SELECT count(*) AS n FROM bookings").get().n, 1, "no ride back unless asked");
  assert.deepEqual(sent, ["booked"]);
  // Pieces it didn't have yet are wanted for recording.
  assert.ok(db.prepare("SELECT 1 FROM clips WHERE text = 'משה' AND status = 'wanted'").get());
});

test("more options at the read-back: someone else, more people, a ride back", async () => {
  const db = setup();
  // The short way to the read-back, then 2 more options, 3 someone else, 2 Rivka (read-back again), 2 more options,
  // 1 more people: 0 men, 2 women (read-back), 2 more, 2 ride back, 0300, 1 book.
  const r = await call(db, ["1", "1", "0", "20", "2", "1200", "2", "3", "2", "2", "1", "0", "2", "2", "2", "0300", "1"]);
  assert.deepEqual(prompts(r[7]), ["P69"]);
  assert.deepEqual(prompts(r[8]), ["P07"]);
  assert.ok(said(r[8]).includes("רבקה"), "names are read out");
  assert.deepEqual(prompts(r[9]), ["P19", "P20"]);
  assert.deepEqual(prompts(r[11]), ["P08"]);
  assert.deepEqual(prompts(r[12]), ["P09"]);
  assert.deepEqual(prompts(r[13]), ["P19", "P20"]);
  assert.deepEqual(prompts(r[15]), ["P16"]);
  assert.ok(said(r[16]).includes("צוריק"), "the ride back is read back");
  assert.deepEqual(prompts(r[17]), ["P21", "P41"]);
  const [b, back] = db.prepare("SELECT * FROM bookings ORDER BY pickup_minute").all();
  assert.equal(b.passenger_id, "ps2");
  assert.equal(b.women, 2);
  assert.equal(b.men, 0);
  assert.equal(back.pickup_minute, 900);
  // 0 at more options goes back to the read-back; 3 at the read-back starts over.
  const again = await call(db, ["1", "1", "0", "20", "1", "2", "0", "3"], { id: "z" });
  assert.deepEqual(prompts(again[7]), ["P19", "P20"]);
  assert.deepEqual(prompts(again[8]), ["P06"]);
});

test("more people: just how many men and women in all, no 'together' question; a full van offers the next time", async () => {
  const db = setup();
  // 1 order, 2 more people, 1 man, 6 women: no "may they sit together" question, straight to "from".
  const big = await call(db, ["1", "2", "1", "6", "0", "20", "2", "1200", "1"], { id: "a" });
  assert.deepEqual(prompts(big[2]), ["P08"]);
  assert.deepEqual(prompts(big[3]), ["P09"]);
  assert.deepEqual(prompts(big[4]), ["P11"]);
  const b = db.prepare("SELECT * FROM bookings").get();
  assert.equal(b.men, 1);
  assert.equal(b.women, 6);
  assert.equal(b.together, 0);
  assert.equal(b.passenger_id, "ps1", "Moshe is one of the men");
  await acceptRide(db, travel, b.id, "drv1", settings, now);
  // Rivka alone: for someone else under more options.
  const r = await call(db, ["1", "1", "0", "20", "2", "1200", "2", "3", "2", "1"], { id: "b" });
  const offer = r[r.length - 1];
  assert.deepEqual(prompts(offer), ["P23", "P27", "P27b"]);
  const take = await phoneStep(ctx(db), { call_id: "b", from: "8455550001", step: offer.gather.step, keys: "1" });
  assert.deepEqual(prompts(take), ["P21", "P41"]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM bookings").get().n, 2);
});

test("wrong keys are asked again, and twice wrong says goodbye", async () => {
  const db = setup();
  const r = await call(db, ["7", "", "8"]);
  assert.deepEqual(prompts(r[1]), ["P42", "P04"]);
  assert.deepEqual(prompts(r[2]), ["P43", "P04"]);
  assert.deepEqual(prompts(r[3]), ["P41"]);
  assert.equal(r[3].hangup, true);
});

test("my rides lists today's rides, and a ride can be cancelled by phone", async () => {
  const db = setup();
  await call(db, ["1", "1", "0", "20", "2", "1200", "1"], { id: "a" });
  const list = await call(db, ["2"], { id: "b" });
  assert.deepEqual(prompts(list[1]), ["P29", "P31", "P30b", "P35"]);
  const cancel = await call(db, ["3", "1", "1"], { id: "c" });
  assert.deepEqual(prompts(cancel[3]), ["P34", "P04"]);
  assert.equal(db.prepare("SELECT status FROM bookings").get().status, "cancelled");
  const none = await call(db, ["2"], { id: "d" });
  assert.deepEqual(prompts(none[1]), ["P28", "P04"]);
});

test("the pickup place can be changed by phone only more than 30 minutes ahead", async () => {
  const db = setup();
  db.prepare("INSERT INTO places (id, household_id, code, name, address, lat, lng) VALUES ('store', NULL, '21', 'Store', '3 Other St', 46, -74)").run();
  await call(db, ["1", "1", "0", "20", "2", "1200", "1"], { id: "a" });
  const r = await call(db, ["2", "2", "21"], { id: "b" });
  assert.deepEqual(prompts(r[3]), ["P46", "P04"]);
  assert.equal(db.prepare("SELECT pickup_place_id FROM bookings").get().pickup_place_id, "store");
  const late = await call(db, ["2", "2"], { id: "c", extra: { now: new Date("2026-11-11T16:45:00Z") } });
  assert.deepEqual(prompts(late[2]), ["P36", "P41"]);
});

test("a place with a 3-digit code is picked by phone", async () => {
  const db = setup();
  db.prepare("INSERT INTO places (id, household_id, code, name, address, lat, lng) VALUES ('store', NULL, '123', 'Store', '3 Other St', 46, -74)").run();
  await call(db, ["1", "1", "0", "123", "2", "1200", "1"], { id: "a" });
  assert.equal(db.prepare("SELECT dropoff_place_id FROM bookings").get().dropoff_place_id, "store");
});

test("messages: queued by the phone's setting, sent through Fonory, retried when unanswered", async () => {
  const db = setup();
  await call(db, ["1", "1", "0", "20", "2", "1015", "1"], { id: "a" });
  const b = db.prepare("SELECT * FROM bookings").get();
  await acceptRide(db, travel, b.id, "drv1", settings, now);
  assert.equal(notifyBooking(db, getBooking(db, b.id), "accepted", {}, now.toISOString()), 2);
  const textRow = db.prepare("SELECT body FROM deliveries WHERE kind = 'accepted' AND channel = 'text'").get();
  assert.match(textRow.body, /אייער רייד איז קאנפירמט/);
  assert.match(textRow.body, /צען פופצן אינדערפרי/);

  // Reminder 5 minutes before the 10:15 pickup.
  assert.equal(queueReminders(db, settings, new Date("2026-11-11T15:05:00Z")), 0);
  assert.equal(queueReminders(db, settings, new Date("2026-11-11T15:11:00Z")), 2);
  assert.equal(queueReminders(db, settings, new Date("2026-11-11T15:12:00Z")), 0);

  assert.equal(await sendDue(db, null, now), 0, "nothing goes out until Fonory is connected");
  const calls = [];
  const texts = [];
  const client = { call: async (to, step) => (calls.push([to, step]), `fc${calls.length}`), text: async (to, body) => texts.push([to, body]) };
  await sendDue(db, client, new Date("2026-11-11T15:11:00Z"));
  assert.equal(texts.length, 2); // the accepted and reminder texts
  assert.equal(calls.length, 2); // the accepted and reminder calls
  const reminder = db.prepare("SELECT * FROM deliveries WHERE kind = 'reminder' AND channel = 'voice'").get();
  // No answer: tried again a minute later, then given up after 3 calls.
  assert.equal(callEnded(db, reminder.call_id, "no_answer", new Date("2026-11-11T15:11:30Z")), "retry");
  await sendDue(db, client, new Date("2026-11-11T15:12:40Z"));
  const again = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(reminder.id);
  assert.equal(callEnded(db, again.call_id, "busy", new Date("2026-11-11T15:12:45Z")), "retry");
  await sendDue(db, client, new Date("2026-11-11T15:14:00Z"));
  const third = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(reminder.id);
  assert.equal(callEnded(db, third.call_id, "no_answer", new Date("2026-11-11T15:14:30Z")), "given_up");
  assert.equal(db.prepare("SELECT status FROM deliveries WHERE id = ?").get(reminder.id).status, "no_answer");

  // Calling back afterwards, the caller can confirm that ride first.
  const back = await call(db, ["1", "1"], { id: "back", extra: { now: new Date("2026-11-11T15:15:00Z") } });
  assert.deepEqual(prompts(back[0]), ["P01", "P05"]);
  assert.deepEqual(prompts(back[1]), ["P30a", "P04"]);
  assert.equal(getBooking(db, b.id).confirmed_by_passenger, 1);
});

test("outgoing calls: the reminder takes 1 or 2, a time change is agreed by phone", async () => {
  const db = setup();
  await call(db, ["1", "1", "0", "20", "2", "1200", "1"], { id: "a" });
  const b = db.prepare("SELECT * FROM bookings").get();
  await acceptRide(db, travel, b.id, "drv1", settings, now);
  notifyBooking(db, getBooking(db, b.id), "reminder");
  const d = db.prepare("SELECT id FROM deliveries WHERE kind = 'reminder' AND channel = 'voice'").get();
  const first = await phoneStep(ctx(db), { call_id: "o1", from: "+18455550001", direction: "outbound", step: `out:${d.id}`, keys: "" });
  assert.deepEqual(prompts(first), ["P37a", "P37b"]);
  assert.ok(said(first).includes("משה"));
  const yes = await phoneStep(ctx(db), { call_id: "o1", from: "+18455550001", step: first.gather.step, keys: "1" });
  assert.deepEqual(prompts(yes), ["P30a", "P41"]);
  assert.equal(getBooking(db, b.id).confirmed_by_passenger, 1);

  // A second ride: the driver offers 12:30 instead of 12:00 and the caller agrees.
  await call(db, ["1", "1", "0", "20", "2", "0100", "1"], { id: "c" });
  const p = db.prepare("SELECT * FROM bookings WHERE pickup_minute = 780").get();
  db.prepare("UPDATE bookings SET status = 'proposed', proposed_minute = 810, driver_id = 'drv1' WHERE id = ?").run(p.id);
  notifyBooking(db, getBooking(db, p.id), "time_change", { oldMinute: 780, newMinute: 810 });
  const tc = db.prepare("SELECT id FROM deliveries WHERE kind = 'time_change' AND channel = 'voice'").get();
  const ask = await phoneStep(ctx(db), { call_id: "o2", from: "+18455550001", step: `out:${tc.id}`, keys: "" });
  assert.deepEqual(prompts(ask), ["P38a", "P38b"]);
  const agree = await phoneStep(ctx(db), { call_id: "o2", from: "+18455550001", step: ask.gather.step, keys: "1" });
  assert.deepEqual(prompts(agree), ["P39", "P31", "P41"]);
  const after = getBooking(db, p.id);
  assert.equal(after.status, "accepted");
  assert.equal(after.pickup_minute, 810);
});

test("wanted pieces are recorded and then played from our server", async () => {
  const db = setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clips-"));
  await call(db, ["1", "1", "0", "20", "1"]);
  assert.ok(db.prepare("SELECT 1 FROM clips WHERE text = 'משה'").get());
  const made = await makeWanted(db, dir, async () => Buffer.alloc(100, 1));
  assert.ok(made > 0);
  const again = await call(db, ["1", "1", "0", "20", "1"], { id: "c2" });
  const audio = again[5].play.filter((p) => p.audio);
  assert.ok(audio.length > 0);
  assert.match(audio[0].audio, /^https:\/\/dispatch\.example\/audio\/clips\/[a-f0-9]+\.wav$/);
});

test("Yiddish Tools WAVs get their real sizes and the shloimy voice", async () => {
  const { yiddishVoice, fixWavSizes } = await import("../src/phone/yiddishtools.js");
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii"); head.writeUInt32LE(0x80000023, 4); head.write("WAVE", 8, "ascii");
  head.write("data", 36, "ascii"); head.writeUInt32LE(0x7fffffff, 40);
  const wav = Buffer.concat([head, Buffer.alloc(100, 1)]);
  let sent;
  const speak = yiddishVoice({ YIDDISH_TOOLS_API_KEY: "k" }, async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.length) };
  });
  const out = await speak("שלום");
  assert.equal(sent.voice, "shloimy");
  assert.equal(out.readUInt32LE(4), 136);
  assert.equal(out.readUInt32LE(40), 100);
  assert.equal(fixWavSizes(Buffer.from("not a wav")).toString(), "not a wav");
});

test("with the driver offline, the caller hears the ride waits unconfirmed", async () => {
  const db = setup();
  db.prepare("UPDATE drivers SET status = 'offline'").run();
  const r = await call(db, ["1", "1", "0", "20", "2", "1200", "1"]);
  assert.deepEqual(prompts(r[r.length - 1]), ["P22", "P41"]);
});

test("a caller is known by a family's phone or one person's phone; a family's phone picks who rides", async () => {
  const db = setup();
  db.prepare("INSERT INTO phones (number, household_id, passenger_id, notify) VALUES ('+18455550002', 'hh1', NULL, 'both')").run();
  // One person's phone: that person, no question.
  await call(db, ["1", "1", "0", "20", "2", "1200", "1"], { from: "8455550001", id: "me1" });
  // The family's phone: 1 for myself, then the names: 2 Rivka.
  const fam = await call(db, ["1", "1", "2", "0", "20", "2", "1230", "1"], { from: "845-555-0002", id: "me2" });
  assert.deepEqual(prompts(fam[1]), ["P06"]);
  assert.deepEqual(prompts(fam[2]), ["P07"]);
  assert.deepEqual(prompts(fam[3]), ["P11"]);
  // A family with nobody entered yet just says how many: 1 man, 0 women.
  db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hh2', 'Family B', 'x')").run();
  db.prepare("INSERT INTO phones (number, household_id, notify) VALUES ('+18455550003', 'hh2', 'both')").run();
  db.prepare("INSERT INTO places (id, household_id, code, name, address, lat, lng) VALUES ('store', NULL, '21', 'Store', '3 Other St', 46, -74)").run();
  const none = await call(db, ["1", "1", "1", "0", "21", "20", "2", "0100", "1"], { from: "8455550003", id: "me3" });
  assert.deepEqual(prompts(none[2]), ["P08"]);
  const rows = db.prepare("SELECT booked_by_phone, household_id, passenger_id, men, women FROM bookings ORDER BY pickup_minute").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { booked_by_phone: "+18455550001", household_id: "hh1", passenger_id: "ps1", men: 1, women: 0 },
    { booked_by_phone: "+18455550002", household_id: "hh1", passenger_id: "ps2", men: 0, women: 1 },
    { booked_by_phone: "+18455550003", household_id: "hh2", passenger_id: null, men: 1, women: 0 },
  ]);
});

test("menu key 5 plays the messages sent out to everyone or the caller's family, newest first", async () => {
  const db = setup();
  db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hh2', 'Family B', 'x')").run();
  const add = db.prepare("INSERT INTO announcements (id, text, recording, audience, created_by, created_at) VALUES (?, ?, ?, ?, 'admin', ?)");
  add.run("a1", "Old news", null, "all", "2026-10-01T15:00:00Z"); // over two weeks ago: not played
  add.run("a2", "No rides Friday", null, "all", "2026-11-09T16:00:00Z"); // Monday
  add.run("a3", "Other family", null, "hh2", "2026-11-10T16:00:00Z");
  add.run("a4", "", "msg.wav", "hh1", "2026-11-10T17:00:00Z"); // yesterday, recorded
  const r = await call(db, ["5"]);
  assert.deepEqual(prompts(r[1]), ["P55", "P55", "P04"]);
  assert.ok(r[1].play.some((p) => p.audio === "https://dispatch.example/audio/msg.wav"), "a recording plays as recorded");
  const text = said(r[1]);
  assert.ok(text.includes("No rides Friday"), "a text message is read out");
  assert.ok(!text.includes("Other family") && !text.includes("Old news"));
  assert.ok(text.includes("נעכטן") && text.includes("מאנטאג"), "each says which day it was sent");
  assert.ok(r[1].play.findIndex((p) => p.audio) < r[1].play.findIndex((p) => p.say === "No rides Friday"), "newest first");
  assert.ok(r[1].gather, "back to the menu");
});

test("menu key 5 with no messages says so", async () => {
  const db = setup();
  const r = await call(db, ["5"]);
  assert.deepEqual(prompts(r[1]), ["P54", "P04"]);
});

test("a one-time address: key 3, said out loud, found on the map, read back in English, booked but not saved", async () => {
  const db = setup();
  const looked = [];
  const lookup = async (t) => {
    looked.push(t);
    return /main/i.test(t) ? { status: "found", lat: 41.1, lng: -74.05, formatted: "12 Main St, Monsey, NY 10952, USA", exact: true } : { status: "not_found" };
  };
  const extra = { travel: { ...travel, lookup } };
  // 1 order, # alone = say the address
  const r = await call(db, ["1", "1", "#"], { extra });
  const askAddress = r[r.length - 1];
  assert.deepEqual(askAddress.listen, { step: "from_say", max_s: 20 });
  assert.deepEqual(prompts(askAddress), ["P56"]);
  const step = (step, body) => phoneStep(ctx(db, extra), { call_id: "c1", from: "8455550001", step, keys: "", ...body });
  // Nothing understood, then something not on the map: asked again.
  assert.deepEqual(prompts(await step("from_say", { transcript: "" })), ["P43", "P56"]);
  assert.deepEqual(prompts(await step("from_say", { transcript: "blah" })), ["P59", "P56"]);
  const heard = await step("from_say", { transcript: "twelve main street monsey" });
  assert.deepEqual(prompts(heard), ["P57", "P58"]);
  assert.deepEqual(heard.play.find((p) => p.language === "english"), { say: "12 Main Street, Monsey", language: "english" });
  assert.equal(heard.gather.step, "from_ok");
  const keep = await step("from_ok", { keys: "1" });
  assert.deepEqual(prompts(keep), ["P65"]);
  let last = await step("from_keep", { keys: "2" });
  assert.equal(last.gather.step, "to");
  // To the shul (code 20), later at 12:00.
  for (const keys of ["20", "2", "1200"]) last = await step(last.gather.step, { keys });
  assert.ok(said(last).includes("12 Main Street, Monsey"), "the read-back says the address");
  const done = await step(last.gather.step, { keys: "1" });
  assert.deepEqual(prompts(done), ["P21", "P41"]);
  const b = db.prepare("SELECT * FROM bookings").get();
  assert.equal(b.pickup_place_id, null);
  assert.equal(b.pickup_address, "12 Main St, Monsey, NY 10952, USA");
  assert.equal(b.pickup_lat, 41.1);
  assert.equal(b.dropoff_place_id, "shul");
  assert.equal(db.prepare("SELECT count(*) AS n FROM places").get().n, 2, "nothing added to the family's places");
});

test("a one-time address not found three times goes back to choosing a place", async () => {
  const db = setup();
  const extra = { travel: { ...travel, lookup: async () => ({ status: "not_found" }) } };
  await call(db, ["1", "1", "#"], { extra });
  const step = (body) => phoneStep(ctx(db, extra), { call_id: "c1", from: "8455550001", step: "from_say", keys: "", ...body });
  await step({ transcript: "x" });
  await step({ transcript: "y" });
  const back = await step({ transcript: "z" });
  assert.deepEqual(prompts(back), ["P59", "P11"]);
  assert.equal(back.gather.step, "from");
});

test("more people booked from someone's own phone without them: the ride isn't in their name", async () => {
  const db = setup();
  // Moshe books for 2 women (not himself): 2 more people, 0 men, 2 women.
  await call(db, ["1", "2", "0", "2", "0", "20", "2", "1200", "1"]);
  const b = db.prepare("SELECT * FROM bookings").get();
  assert.equal(b.passenger_id, null);
  assert.equal(b.men, 0);
  assert.equal(b.women, 2);
  // More than 7 is too many for the van.
  const r = await call(db, ["1", "2", "4", "4"], { id: "big" });
  assert.deepEqual(prompts(r.at(-1)), ["P23", "P41"]);
});

test("a new address said on the phone can be kept for everyone: its code is the house number", async () => {
  const db = setup();
  const lookup = async () => ({ status: "found", lat: 41.1, lng: -74.05, formatted: "12 Main St, Monsey, NY 10952, USA", exact: true });
  const extra = { travel: { ...travel, lookup } };
  await call(db, ["1", "1", "#"], { extra });
  const step = (step, body) => phoneStep(ctx(db, extra), { call_id: "c1", from: "8455550001", step, keys: "", ...body });
  await step("from_say", { transcript: "12 main street" });
  await step("from_ok", { keys: "1" });
  const kept = await step("from_keep", { keys: "1" });
  assert.deepEqual(prompts(kept), ["P66", "P12"]);
  assert.deepEqual(said(kept), ["איינס", "צוויי"], "the code is said digit by digit");
  const p = db.prepare("SELECT * FROM places WHERE code = '12'").get();
  assert.equal(p.household_id, null, "shared by everyone");
  assert.equal(p.address, "12 Main St, Monsey, NY 10952, USA");
  // Another family's phone can now press 12.
  db.prepare("INSERT INTO households (id, name, created_at) VALUES ('hh2', 'Family B', 'x')").run();
  db.prepare("INSERT INTO phones (number, household_id, notify) VALUES ('+18455550002', 'hh2', 'both')").run();
  // Nobody entered in that family: 1 man, 0 women, then 2 another place.
  const other = await call(db, ["1", "1", "1", "0"], { from: "8455550002", id: "c2" });
  const r = await phoneStep(ctx(db), { call_id: "c2", from: "8455550002", step: other.at(-1).gather.step, keys: "12" });
  assert.equal(r.gather.step, "to");
  const s2 = db.prepare("SELECT state FROM phone_calls WHERE call_id = 'c2'").get();
  assert.equal(JSON.parse(s2.state).draft.from, p.id);
});

test("code 100 means saying a new address, and menu key 6 just adds one", async () => {
  const db = setup();
  const lookup = async () => ({ status: "found", lat: 41.1, lng: -74.05, formatted: "7 Ronald Dr, Monsey, NY 10952, USA", exact: true });
  const extra = { travel: { ...travel, lookup } };
  const r = await call(db, ["1", "1", "100"], { extra });
  assert.equal(r.at(-1).listen.step, "from_say");
  const m = await call(db, ["6"], { extra, id: "m" });
  assert.equal(m.at(-1).listen.step, "add_say");
  const step = (step, body) => phoneStep(ctx(db, extra), { call_id: "m", from: "8455550001", step, keys: "", ...body });
  await step("add_say", { transcript: "seven ronald drive" });
  const saved = await step("add_ok", { keys: "1" });
  assert.deepEqual(prompts(saved), ["P66", "P04"]);
  assert.equal(saved.gather.step, "menu");
  assert.equal(db.prepare("SELECT name FROM places WHERE code = '07'").get().name, "7 Ronald Drive, Monsey");
});

test("from and to: a place code right away, 0 home, # alone (or no key) says an address, * the list", async () => {
  const db = setup();
  // Order, 0 = from home, 20 = to the shul, # = now: the read-back.
  const r = await call(db, ["1", "1", "0", "20", "#"]);
  assert.equal(r.at(-1).gather.step, "confirm");
  const d = JSON.parse(db.prepare("SELECT state FROM phone_calls WHERE call_id = 'c1'").get().state).draft;
  assert.equal(d.from, "home");
  assert.equal(d.to, "shul");
  assert.equal(d.pickupMinute, null);
  // * reads the list, then asks again.
  const list = await call(db, ["1", "1", "*"], { id: "l" });
  assert.ok(said(list[3]).includes("שול"));
  assert.deepEqual(prompts(list[3]), ["P11"]);
  assert.equal(list[3].gather.step, "from");
  // # alone, a bare # sent as no digits, or no key at all: say the address.
  for (const [i, body] of [{ keys: "#" }, { keys: "", terminated_by: "#" }, { keys: "" }].entries()) {
    const a = await call(db, ["1", "1"], { id: `t${i}` });
    const s = await phoneStep(ctx(db), { call_id: `t${i}`, from: "8455550001", step: a.at(-1).gather.step, ...body });
    assert.equal(s.listen?.step, "from_say");
  }
});

test("fewer questions: no window and no ride-back question, and no # tip", async () => {
  const db = setup();
  const r = await call(db, ["1", "1", "0", "20", "2", "1200"]);
  assert.deepEqual(prompts(r[2]), ["P11"]);
  assert.deepEqual(prompts(r.at(-1)), ["P19", "P20"]);
  assert.ok(!r.some((x) => prompts(x).includes("P17") || prompts(x).includes("P18") || prompts(x).includes("P10")), "no window, ride-back or 'together' question");
  const d = JSON.parse(db.prepare("SELECT state FROM phone_calls WHERE call_id = 'c1'").get().state).draft;
  assert.equal(d.window, 15);
  // "Now" goes straight to the read-back too.
  const now1 = await call(db, ["1", "1", "0", "20", "1"], { id: "n" });
  assert.deepEqual(prompts(now1.at(-1)), ["P19", "P20"]);
});

test("a code two places share: the caller's own family's place wins, otherwise the caller picks by name", async () => {
  const db = setup();
  db.prepare("INSERT INTO places (id, household_id, code, name, address, lat, lng) VALUES ('wal', NULL, '25', 'Walmart', '1 Rt 59', 41, -74)").run();
  db.prepare("INSERT INTO places (id, household_id, code, name, address, lat, lng) VALUES ('viz', NULL, '25', 'Viznitz', '25 Phyllis Ter', 41, -74)").run();
  db.prepare("INSERT INTO places (id, household_id, code, name, address, lat, lng) VALUES ('sat', NULL, '01', 'Satmer', '1 Monsey Blvd', 41, -74)").run();
  const st = (id) => JSON.parse(db.prepare("SELECT state FROM phone_calls WHERE call_id = ?").get(id).state);
  const step = (id, step, keys) => phoneStep(ctx(db), { call_id: id, from: "8455550001", step, keys });
  // Walk to a code question, whatever the short booking asks first.
  async function toCode(id) {
    let r = await phoneStep(ctx(db), { call_id: id, from: "8455550001", step: "start", keys: "" });
    for (let i = 0; i < 12 && r.gather && r.gather.step !== "from"; i++) r = await step(id, r.gather.step, r.gather.step === "menu" ? "1" : "#");
    assert.equal(r.gather?.step, "from");
  }
  await toCode("a");
  await step("a", "from", "1");
  assert.equal(st("a").draft.from, "home", "1: this family's home and Satmer have it; the family's own wins");
  await toCode("b");
  const pick = await step("b", "from", "25");
  assert.equal(pick.gather.step, "from_choose");
  assert.deepEqual(pick.play.filter((p) => p.language === "english").map((p) => p.say), ["Viznitz", "Walmart"]);
  await step("b", "from_choose", "1");
  assert.equal(st("b").draft.from, "viz");
});

test("a time the driver offered is answered by calling in: 1 agrees, 2 cancels, and the driver is kept", async () => {
  const { proposeTime } = await import("../src/bookings.js");
  const db = setup();
  await call(db, ["1", "1", "0", "20", "2", "0100", "1"], { id: "a" });
  const p = db.prepare("SELECT * FROM bookings").get();
  assert.ok(proposeTime(db, p.id, 810, "drv1").ok);
  assert.equal(getBooking(db, p.id).driver_id, "drv1", "the driver who offered the time is on the ride");
  notifyBooking(db, getBooking(db, p.id), "time_change", { oldMinute: 780, newMinute: 810 }, now.toISOString());

  // The caller calls in: the question comes before the menu; a wrong key asks again.
  const first = await phoneStep(ctx(db), { call_id: "in1", from: "8455550001", step: "start", keys: "" });
  assert.deepEqual(prompts(first), ["P01", "P38a", "P38b"]);
  assert.equal(first.gather.step, "time_in");
  const wrong = await phoneStep(ctx(db), { call_id: "in1", from: "8455550001", step: "time_in", keys: "7" });
  assert.deepEqual(prompts(wrong), ["P42", "P38a", "P38b"]);
  const yes = await phoneStep(ctx(db), { call_id: "in1", from: "8455550001", step: "time_in", keys: "1" });
  assert.deepEqual(prompts(yes), ["P39", "P31", "P04"]);
  const after = getBooking(db, p.id);
  assert.equal(after.status, "accepted");
  assert.equal(after.pickup_minute, 810);
  assert.equal(after.driver_id, "drv1");
  // The call that was still waiting to ask is not made any more.
  assert.equal(db.prepare("SELECT count(*) n FROM deliveries WHERE kind = 'time_change' AND status = 'queued'").get().n, 0);
  // The next call goes straight to the menu.
  assert.deepEqual(prompts(await phoneStep(ctx(db), { call_id: "in2", from: "8455550001", step: "start", keys: "" })), ["P01", "P04"]);

  // Another ride, and this time the caller says no: it is cancelled.
  await call(db, ["1", "1", "0", "20", "2", "0300", "1"], { id: "b" });
  const q = db.prepare("SELECT * FROM bookings WHERE pickup_minute = 900").get();
  proposeTime(db, q.id, 930, "drv1");
  const again = await phoneStep(ctx(db), { call_id: "in3", from: "8455550001", step: "start", keys: "" });
  assert.equal(again.gather.step, "time_in");
  const no = await phoneStep(ctx(db), { call_id: "in3", from: "8455550001", step: "time_in", keys: "2" });
  assert.deepEqual(prompts(no), ["P34", "P04"]);
  assert.equal(getBooking(db, q.id).status, "cancelled");
});

test("ride messages that waited over an hour are dropped, not sent late; announcements still go", async () => {
  const db = setup();
  await call(db, ["1", "1", "0", "20", "2", "1015", "1"], { id: "a" });
  const b = db.prepare("SELECT * FROM bookings").get();
  notifyBooking(db, b, "accepted", {}, now.toISOString());
  db.prepare("INSERT INTO announcements (id, text, created_by, created_at) VALUES ('an1', 'x', 'admin', ?)").run(now.toISOString());
  db.prepare("INSERT INTO deliveries (announcement_id, phone, channel, kind, updated_at) VALUES ('an1', '+18455550001', 'text', 'announcement', ?)").run(now.toISOString());
  const texts = [];
  const client = { call: async () => "c", text: async (to, body) => texts.push(body) };
  // The phone line gets connected two hours later.
  await sendDue(db, client, new Date(now.getTime() + 2 * 3600000));
  assert.equal(texts.length, 1, "only the announcement goes out");
  const old = db.prepare("SELECT status, note FROM deliveries WHERE kind = 'accepted'").all();
  assert.ok(old.length && old.every((d) => d.status === "failed" && d.note === "too old to send"));
});

test("the book-it key sent twice at the same moment books the ride once", async () => {
  const db = setup();
  const steps = await call(db, ["1", "1", "0", "20", "2", "1015"], { id: "dup" });
  assert.equal(steps[steps.length - 1].gather.step, "confirm");
  const press = () => phoneStep(ctx(db), { call_id: "dup", from: "8455550001", step: "confirm", keys: "1" });
  const [a, b] = await Promise.all([press(), press()]);
  assert.deepEqual(prompts(a), prompts(b));
  assert.equal(db.prepare("SELECT count(*) n FROM bookings").get().n, 1);
  // And once more afterwards (a late repeat): still one ride.
  await press();
  assert.equal(db.prepare("SELECT count(*) n FROM bookings").get().n, 1);
});

test("an offered time nobody answers goes back to the driver after 20 minutes", async () => {
  const { proposeTime, expireOffers } = await import("../src/bookings.js");
  const db = setup();
  await call(db, ["1", "1", "0", "20", "2", "0100", "1"], { id: "a" });
  const p = db.prepare("SELECT * FROM bookings").get();
  proposeTime(db, p.id, 810, "drv1", now);
  notifyBooking(db, getBooking(db, p.id), "time_change", { oldMinute: 780, newMinute: 810 }, now.toISOString());
  assert.equal(expireOffers(db, new Date(now.getTime() + 19 * 60000)), 0);
  assert.equal(getBooking(db, p.id).status, "proposed");
  assert.equal(expireOffers(db, new Date(now.getTime() + 21 * 60000)), 1);
  const after = getBooking(db, p.id);
  assert.equal(after.status, "pending");
  assert.equal(after.pickup_minute, 780);
  assert.equal(after.proposed_minute, null);
  assert.equal(db.prepare("SELECT count(*) n FROM deliveries WHERE kind = 'time_change' AND status = 'queued'").get().n, 0);
});
