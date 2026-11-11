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

test("booking a ride by phone, from the greeting to the driver", async () => {
  const db = setup();
  const sent = [];
  // 1 order, 2 someone else, 2 Rivka, 0 men, 2 women, 1 from home, 2 other place, code 20, 2 later, 1200, 1 = 15 min,
  // 2 no return, 1 correct.
  const r = await call(db, ["1", "2", "2", "0", "2", "1", "2", "20", "2", "1200", "1", "2", "1"], { extra: { notify: (b, k) => sent.push(k) } });
  assert.deepEqual(prompts(r[0]), ["P01", "P04"]);
  assert.deepEqual(prompts(r[2]), ["P07"]);
  assert.ok(said(r[2]).includes("רבקה"), "names are read out");
  const readBack = r[r.length - 2];
  assert.deepEqual(prompts(readBack), ["P19", "P20"]);
  assert.deepEqual(said(readBack), ["רבקה", "צוויי", "פרויען", "פון", "שטוב", "קיין", "שול", "אום", "צוועלף", "נאכמיטאג"]);
  const done = r[r.length - 1];
  assert.deepEqual(prompts(done), ["P21", "P41"]);
  assert.equal(done.hangup, true);
  const b = db.prepare("SELECT * FROM bookings").get();
  assert.equal(b.passenger_id, "ps2");
  assert.equal(b.women, 2);
  assert.equal(b.pickup_minute, 720);
  assert.equal(b.status, "pending");
  assert.deepEqual(sent, ["booked"]);
  // Pieces it didn't have yet are wanted for recording.
  assert.ok(db.prepare("SELECT 1 FROM clips WHERE text = 'רבקה' AND status = 'wanted'").get());
});

test("men and women together are asked about; a full van offers the next time", async () => {
  const db = setup();
  const big = (await call(db, ["1", "1", "1", "6", "1", "1", "2", "20", "2", "1200", "1", "2", "1"], { id: "a" }));
  assert.deepEqual(prompts(big[4]), ["P10"]);
  const b = db.prepare("SELECT * FROM bookings").get();
  await acceptRide(db, travel, b.id, "drv1", settings, now);
  const r = await call(db, ["1", "1", "0", "1", "1", "2", "20", "2", "1200", "1", "2", "1"], { id: "b" });
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
  await call(db, ["1", "1", "1", "0", "1", "2", "20", "2", "1200", "1", "2", "1"], { id: "a" });
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
  await call(db, ["1", "1", "1", "0", "1", "2", "20", "2", "1200", "1", "2", "1"], { id: "a" });
  const r = await call(db, ["2", "2", "21"], { id: "b" });
  assert.deepEqual(prompts(r[3]), ["P46", "P04"]);
  assert.equal(db.prepare("SELECT pickup_place_id FROM bookings").get().pickup_place_id, "store");
  const late = await call(db, ["2", "2"], { id: "c", extra: { now: new Date("2026-11-11T16:45:00Z") } });
  assert.deepEqual(prompts(late[2]), ["P36", "P41"]);
});

test("messages: queued by the phone's setting, sent through Fonory, retried when unanswered", async () => {
  const db = setup();
  await call(db, ["1", "1", "1", "0", "1", "2", "20", "2", "1015", "1", "2", "1"], { id: "a" });
  const b = db.prepare("SELECT * FROM bookings").get();
  await acceptRide(db, travel, b.id, "drv1", settings, now);
  assert.equal(notifyBooking(db, getBooking(db, b.id), "accepted"), 2);
  const textRow = db.prepare("SELECT body FROM deliveries WHERE kind = 'accepted' AND channel = 'text'").get();
  assert.match(textRow.body, /אייער רייד איז קאנפירמט/);
  assert.match(textRow.body, /צען פופצן אינדערפרי/);

  // Reminder 5 minutes before the 10:15 pickup.
  assert.equal(queueReminders(db, settings, new Date("2026-11-11T15:05:00Z")), 0);
  assert.equal(queueReminders(db, settings, new Date("2026-11-11T15:11:00Z")), 2);
  assert.equal(queueReminders(db, settings, new Date("2026-11-11T15:12:00Z")), 0);

  assert.equal(await sendDue(db, null), 0, "nothing goes out until Fonory is connected");
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
  const back = await call(db, ["1"], { id: "back", extra: { now: new Date("2026-11-11T15:15:00Z") } });
  assert.deepEqual(prompts(back[0]), ["P01", "P05"]);
  assert.deepEqual(prompts(back[1]), ["P30a", "P04"]);
  assert.equal(getBooking(db, b.id).confirmed_by_passenger, 1);
});

test("outgoing calls: the reminder takes 1 or 2, a time change is agreed by phone", async () => {
  const db = setup();
  await call(db, ["1", "1", "1", "0", "1", "2", "20", "2", "1200", "1", "2", "1"], { id: "a" });
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
  await call(db, ["1", "1", "1", "0", "1", "2", "20", "2", "0100", "1", "2", "1"], { id: "c" });
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
  await call(db, ["1", "2"]);
  assert.ok(db.prepare("SELECT 1 FROM clips WHERE text = 'משה'").get());
  const made = await makeWanted(db, dir, async () => Buffer.alloc(100, 1));
  assert.ok(made > 0);
  const again = await call(db, ["1", "2"], { id: "c2" });
  const audio = again[2].play.filter((p) => p.audio);
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
  const r = await call(db, ["1", "2", "2", "0", "2", "1", "2", "20", "2", "1200", "1", "2", "1"]);
  assert.deepEqual(prompts(r[r.length - 1]), ["P22", "P41"]);
});

test("a caller is known by a family's phone or one person's phone; 'for myself' means that person", async () => {
  const db = setup();
  db.prepare("INSERT INTO phones (number, household_id, passenger_id, notify) VALUES ('+18455550002', 'hh1', NULL, 'both')").run();
  // 1 order, 1 for myself, 1 man, 0 women, 1 from home, 2 other place, code 20, 2 later, 1200, 1 = 15 min, 2 no return, 1 correct.
  const keys = ["1", "1", "1", "0", "1", "2", "20", "2", "1200", "1", "2", "1"];
  await call(db, keys, { from: "8455550001", id: "me1" });
  await call(db, keys.map((k) => (k === "1200" ? "1230" : k)), { from: "845-555-0002", id: "me2" });
  const rows = db.prepare("SELECT booked_by_phone, household_id, passenger_id FROM bookings ORDER BY pickup_minute").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { booked_by_phone: "+18455550001", household_id: "hh1", passenger_id: "ps1" },
    { booked_by_phone: "+18455550002", household_id: "hh1", passenger_id: null },
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
  // 1 order, 1 for myself, 1 man, 0 women, 3 = from a one-time address
  const r = await call(db, ["1", "1", "1", "0", "3"], { extra });
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
  let last = await step("from_ok", { keys: "1" });
  assert.equal(last.gather.step, "to");
  // To the shul (code 20), later at 12:00, 15 minutes, no return.
  for (const keys of ["2", "20", "2", "1200", "1", "2"]) last = await step(last.gather.step, { keys });
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
  await call(db, ["1", "1", "1", "0", "3"], { extra });
  const step = (body) => phoneStep(ctx(db, extra), { call_id: "c1", from: "8455550001", step: "from_say", keys: "", ...body });
  await step({ transcript: "x" });
  await step({ transcript: "y" });
  const back = await step({ transcript: "z" });
  assert.deepEqual(prompts(back), ["P59", "P11"]);
  assert.equal(back.gather.step, "from");
});
