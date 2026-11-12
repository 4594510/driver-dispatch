// The phone menu: one answer for every step of every call (POST /fonory/step). The flow is the "Incoming call" and
// "Outgoing calls" sections of the phone setup doc. It takes { call_id, from, direction, step, keys } and answers
// { play: [{ prompt } | { audio } | { say }], gather?: { step, max_keys, timeout_s }, hangup }; src/phone/fonory.js
// (readStep, toActions) translates to and from Teltech's Ride Line format.
// Where the caller is (the ride being ordered, the list just read out) is kept per call in phone_calls.
import { nowIso, audit } from "../db.js";
import { approvedPhone, changeStatus, getBooking } from "../bookings.js";
import { bookRide, acceptRide, refreshDay } from "../dispatch.js";
import { keypadTime, localParts, canChangePickup, normalCode } from "../rules.js";
import { W, numberWords, timePieces, dayPieces } from "./words.js";
import { piece, namePiece } from "./audio.js";
import { driverAvailable } from "../driver.js";
import { AREA_KM } from "../travel.js";
import { allPlaces, codeMatches, savePlace, MAX_CODE_DIGITS, SAY_CODE } from "../places.js";
import { upcomingChanges } from "../schedule.js";
import { recentAnnouncements } from "../announcements.js";
import { peopleForFamily } from "../relations.js";

const ACTIVE = ["pending", "proposed", "accepted", "picked_up"];
const CANCELLABLE = ["pending", "proposed", "accepted"];
const TRIES = 2;
// What "#" means at each question: the usual answer. Questions that book or cancel need a real key.
const SKIP = {
  who: "1", more: "0", with: "0", extra: "2", extra_men: "0", extra_women: "0", men: "0", women: "0", together: "2",
  from: "1", to: "1", from_keep: "2", to_keep: "2", when: "1", ret: "2", reminder_in: "2",
};
const CODE_KEYS = MAX_CODE_DIGITS;
// Fewer questions (feedback 2026-11-11: "too many steps"): the pickup window is no longer asked, every ride gets the
// usual 15 minutes; and the "#" tip (P67) is said only until a phone has booked a few rides.
const WINDOW = 15;
const TIP_BOOKINGS = 3;
// The short way (Shloime, 2026-11-12: "quick, easy, simple; the advanced options behind a choice for more"): who (only
// on a family's phone), from, to, when, then the read-back. Everything else (more people, a ride back, someone else)
// is under "more options" at the read-back, and each of those comes back to the read-back.

const P = (code) => ({ prompt: code });

// ctx: { db, travel, settings, now, base, notify(booking, kind, payload) }
export async function phoneStep(ctx, body) {
  const { db } = ctx;
  const callId = String(body.call_id || "");
  const from = normalize(body.from);
  const step = String(body.step || "start");
  const raw = String(body.keys ?? "").replace(/[^0-9*#]/g, "");
  // "#" alone skips a question: it takes the usual answer (SKIP). Teltech may also send a bare # as no digits with
  // terminated_by "#".
  const skipped = raw === "#" || (raw === "" && body.terminated_by === "#");
  const keys = skipped && SKIP[step] != null ? SKIP[step] : raw.replace(/#$/, "");
  if (!callId || !from) return { play: [P("P03")], hangup: true };

  let call = db.prepare("SELECT * FROM phone_calls WHERE call_id = ?").get(callId);
  if (!call) {
    const out = /^out:(\d+)$/.exec(step);
    db.prepare("INSERT INTO phone_calls (call_id, phone, direction, delivery_id, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      callId, from, out ? "outbound" : body.direction === "outbound" ? "outbound" : "inbound", out ? Number(out[1]) : null, nowIso(), nowIso());
    call = db.prepare("SELECT * FROM phone_calls WHERE call_id = ?").get(callId);
  }
  const st = JSON.parse(call.state || "{}");
  // A name in English letters (a saved address like "Town Square Mall") is said in English; Yiddish ones in Yiddish.
  const name = (row) => row && !row.recording && !row.spoken && /[A-Za-z]/.test(row.name) && !/[\u0590-\u05FF]/.test(row.name)
    ? { say: row.name, language: "english" } : namePiece(db, ctx.base, row);
  const c = { ...ctx, call, st, keys, step, from, transcript: body.transcript ?? null, say: (t) => piece(db, ctx.base, t), name };
  const res = call.delivery_id ? await outbound(c) : await inbound(c);
  db.prepare("UPDATE phone_calls SET state = ?, updated_at = ? WHERE call_id = ?").run(JSON.stringify(st), nowIso(), callId);
  return clean(res);
}

function normalize(s) {
  const d = String(s || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}
const clean = (res) => ({ ...res, play: (res.play || []).flat(Infinity).filter(Boolean), hangup: !!res.hangup });
const ask = (step, play, maxKeys = 1) => ({ play, gather: { step, max_keys: maxKeys, timeout_s: 6 } });
// Let the caller speak (a one-time address): Fonory turns it into text and comes back to `step` with it.
const listen = (step, play) => ({ play, listen: { step, max_s: 20 } });
const end = (play) => ({ play: [play, P("P41")], hangup: true });

// A wrong key or none: say so and ask again, twice at most, then say goodbye.
function retry(c, step, question, maxKeys = 1) {
  c.st.tries ||= {};
  c.st.tries[step] = (c.st.tries[step] || 0) + 1;
  if (c.st.tries[step] > TRIES) return end([]);
  return ask(step, [P(c.keys ? "P42" : "P43"), question], maxKeys);
}
// The same, when the answer was a real one that doesn't fit (a time outside today's hours): say why instead.
function retryBecause(c, step, why, question, maxKeys = 1) {
  c.st.tries ||= {};
  c.st.tries[step] = (c.st.tries[step] || 0) + 1;
  if (c.st.tries[step] > TRIES) return end([why]);
  return ask(step, [why, question], maxKeys);
}
const settle = (c, step) => {
  if (c.st.tries) delete c.st.tries[step];
};

// ---------- pieces ----------
const timeOf = (c, minute) => timePieces(minute).map((t) => c.say(t));
const digitsOf = (c, s) => String(s).split("").map((d) => c.say(numberWords(Number(d))));
const numberOf = (c, n) => c.say(numberWords(n));

function placeRow(c, id) {
  return id ? c.db.prepare("SELECT * FROM places WHERE id = ?").get(id) : null;
}
// "12 Main St, Monsey, NY 10952, USA" → "12 Main Street, Monsey": the part worth saying back, in words.
const STREET_WORDS = { St: "Street", Rd: "Road", Ave: "Avenue", Ln: "Lane", Dr: "Drive", Ct: "Court", Pl: "Place", Blvd: "Boulevard", Ter: "Terrace", Hwy: "Highway", Pkwy: "Parkway", Cir: "Circle", N: "North", S: "South", E: "East", W: "West" };
export function spokenAddress(address) {
  const parts = String(address || "").split(",").map((x) => x.trim()).filter(Boolean)
    .filter((x) => !/^(USA|United States)$/i.test(x) && !/^[A-Z]{2}( \d{5}(-\d{4})?)?$/.test(x));
  return parts.slice(0, 2).join(", ").replace(/\b([A-Z][a-z]{0,3})\b\.?/g, (m, w) => STREET_WORDS[w] || m);
}
// A ride end: a saved place by its name, or a one-time address read out in English.
function endPiece(c, placeId, address) {
  const row = placeRow(c, placeId);
  return row ? c.name(row) : address ? { say: spokenAddress(address), language: "english" } : null;
}
function riderPiece(c, b) {
  const p = b.passenger_id ? c.db.prepare("SELECT * FROM passengers WHERE id = ?").get(b.passenger_id) : null;
  return p ? c.name(p) : b.rider_name ? c.say(b.rider_name) : null;
}
function peopleOf(c, men, women) {
  return [men ? [numberOf(c, men), c.say(men === 1 ? W.man : W.men)] : null, men && women ? c.say(W.and) : null, women ? [numberOf(c, women), c.say(women === 1 ? W.woman : W.women)] : null];
}

// ---------- the schedule ----------
// Today's hours (c.settings holds today's, from getSettings(db, now)): "today there are rides from 10 to 6", or "today
// there are no rides".
function hoursToday(c) {
  if (c.settings.closed) return [P("P49")];
  return [P("P48"), timeOf(c, c.settings.openMinute), c.say(W.until), timeOf(c, c.settings.closeMinute)];
}
const usualOpen = (c) => c.settings.usualOpenMinute ?? c.settings.openMinute;
const usualClose = (c) => c.settings.usualCloseMinute ?? c.settings.closeMinute;
const fitsToday = (c, m) => !c.settings.closed && m >= c.settings.openMinute && m <= c.settings.closeMinute;
// Menu key 4: today, the usual hours, and the changes in the next two weeks.
function scheduleSpeech(c) {
  const usual = { ...c.settings, openMinute: usualOpen(c), closeMinute: usualClose(c) };
  const changes = upcomingChanges(c.db, usual, c.now);
  const day = (d) => dayPieces(d, today(c).day).map((t) => c.say(t));
  return [
    hoursToday(c),
    [P("P50"), timeOf(c, usual.openMinute), c.say(W.until), timeOf(c, usual.closeMinute)],
    changes.length ? P("P51") : null,
    changes.map((g) => [
      g.from === g.to ? day(g.from) : [c.say(W.from), day(g.from), c.say(W.until), day(g.to)],
      g.closed ? P("P53") : [P("P52"), timeOf(c, g.openMinute), c.say(W.until), timeOf(c, g.closeMinute)],
    ]),
  ];
}

// ---------- messages sent out ----------
// Menu key 5: the messages from the last two weeks to everyone or to this family, newest first: "message number 1, from
// Monday:", then the admin's recording, or the text in Fonory's Yiddish voice.
function messagesSpeech(c) {
  const list = recentAnnouncements(c.db, c.phone.household_id, c.now);
  if (!list.length) return [P("P54")];
  const day = today(c).day;
  return list.map((a, i) => [
    P("P55"), numberOf(c, i + 1), c.say(W.from),
    dayPieces(localParts(new Date(a.created_at), c.settings.timeZone).day, day).map((t) => c.say(t)),
    a.recording ? { audio: `${c.base}/audio/${a.recording}` } : { say: a.text },
  ]);
}

// ---------- incoming ----------
const MENU = [P("P04")];

async function inbound(c) {
  const phone = approvedPhone(c.db, c.from);
  if (!phone) return { play: [P("P02")], hangup: true };
  c.phone = phone;
  const handler = STEPS[c.step] || STEPS.start;
  return handler(c);
}

const today = (c) => localParts(c.now, c.settings.timeZone);

function ridesToday(c, statuses) {
  return c.db
    .prepare(`SELECT * FROM bookings WHERE day = ? AND household_id = ? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY pickup_minute`)
    .all(today(c).day, c.phone.household_id, ...statuses);
}
function rideItems(c, b, i) {
  return [
    P("P29"), numberOf(c, i + 1), riderPiece(c, b),
    c.say(W.from), endPiece(c, b.pickup_place_id, b.pickup_address), c.say(W.to), endPiece(c, b.dropoff_place_id, b.dropoff_address),
    P("P31"), timeOf(c, b.eta_minute ?? b.pickup_minute),
    P(["accepted", "picked_up"].includes(b.status) ? "P30a" : "P30b"),
  ];
}
// Every saved address is shared for now (places.js).
function placesFor(c) {
  return allPlaces(c.db);
}
function homeOf(c) {
  return c.db
    .prepare("SELECT * FROM places WHERE active = 1 AND household_id = ? ORDER BY kind != 'home', length(code), code LIMIT 1")
    .get(c.phone.household_id);
}
function placeList(c) {
  return placesFor(c).map((p) => [digitsOf(c, p.code), c.name(p)]);
}

// Each question, so it can be asked again.
const Q = {
  menu: () => MENU,
  who: () => [P("P06")],
  more: () => [P("P69")],
  men: () => [P("P08")],
  women: () => [P("P09")],
  with: () => [P("P61")],
  extra: () => [P("P62")],
  extra_men: () => [P("P63")],
  extra_women: () => [P("P64")],
  together: () => [P("P10")],
  from: () => [P("P11")],
  to: () => [P("P12")],
  from_code: () => [P("P13"), P("P14")],
  to_code: () => [P("P13"), P("P14")],
  change_code: () => [P("P13"), P("P14")],
  when: () => [P("P15")],
  time: () => [P("P16")],
  ret_time: () => [P("P16")],
  ret: () => [P("P18")],
  rides_menu: () => [P("P35")],
  change_which: () => [P("P47")],
  cancel_which: () => [P("P32")],
  cancel_confirm: () => [P("P33")],
  reminder_in: () => [P("P05")],
};

function members(c) {
  return c.db.prepare("SELECT * FROM passengers WHERE household_id = ? AND active = 1 ORDER BY name").all(c.phone.household_id);
}
function whoPick(c) {
  const list = members(c);
  return [P("P07"), list.map((p, i) => [c.name(p), c.say(W.press), numberOf(c, i + 1)])];
}

// ---------- who is coming ----------
// After "for myself" or the person picked, the caller adds others from the list (the family and their relatives),
// one number at a time, then says if anyone not on the list comes too. men and women always count everyone.
const passenger = (c, id) => c.db.prepare("SELECT * FROM passengers WHERE id = ?").get(id);
const namedIds = (d) => [d.passengerId, ...(d.with || [])].filter(Boolean);
function withList(c) {
  const taken = new Set(namedIds(c.st.draft));
  return peopleForFamily(c.db, c.phone.household_id).filter((p) => !taken.has(p.id));
}
// The list keeps its numbers while people are added, so the caller can go by what they heard.
function withChoices(c) {
  c.st.draft.choices ||= withList(c).map((p) => p.id);
  return c.st.draft.choices;
}
const withKeys = (c) => (withChoices(c).length > 9 ? 2 : 1);
function withSpeech(c) {
  const taken = new Set(namedIds(c.st.draft));
  return withChoices(c).map((id, i) => (taken.has(id) ? null : [c.name(passenger(c, id)), c.say(W.press), numberOf(c, i + 1)]));
}
function askWith(c) {
  if (!withList(c).length) return afterWith(c);
  return ask("with", [P("P60"), withSpeech(c), P("P61")], withKeys(c));
}
function afterWith(c) {
  const d = c.st.draft;
  if (!namedIds(d).length) return ask("men", Q.men()); // nobody named: just how many men and women
  return ask("extra", Q.extra());
}
function namedCount(c, g) {
  return namedIds(c.st.draft).map((id) => passenger(c, id)).filter((p) => p?.gender === g).length;
}
// Ask whether men and women may sit together only when it matters: someone of each, and not all of them already
// allowed to by a seat rule.
function afterPeople(c) {
  const d = c.st.draft;
  if (d.men && d.women && !allMayMix(c)) return ask("together", Q.together());
  return onward(c, "from");
}
// After a question: the next one on the short way, or back to the read-back when it came from "more options".
function onward(c, next) {
  if (c.st.draft?.editing) return ask("confirm", readBack(c));
  return ask(next, Q[next]());
}
// Who rides: a phone of one person books that person; a family's phone picks a name; a family with nobody entered
// just says how many men and women.
function startRide(c) {
  const d = c.st.draft;
  if (c.phone.passenger_id) {
    d.passengerId = c.phone.passenger_id;
    setPeople(c, 0, 0);
    return null;
  }
  if (members(c).length) return ask("who_pick", whoPick(c), members(c).length > 9 ? 2 : 1);
  return ask("men", Q.men());
}
function allMayMix(c) {
  const d = c.st.draft;
  if (d.extraMen || d.extraWomen) return false;
  const ps = namedIds(d).map((id) => passenger(c, id));
  const ok = c.db.prepare("SELECT 1 FROM relations WHERE seating = 'together' AND ((a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?))");
  for (const m of ps.filter((p) => p.gender === "m")) {
    for (const w of ps.filter((p) => p.gender === "f")) if (!ok.get(m.id, w.id, w.id, m.id)) return false;
  }
  return true;
}
function setPeople(c, extraMen, extraWomen) {
  const d = c.st.draft;
  d.extraMen = extraMen;
  d.extraWomen = extraWomen;
  d.men = namedCount(c, "m") + extraMen;
  d.women = namedCount(c, "f") + extraWomen;
}

function toReadBack(c) {
  c.st.draft.returnMinute ??= null;
  return ask("confirm", readBack(c));
}
function readBack(c) {
  const d = c.st.draft;
  const named = namedIds(d).map((id) => passenger(c, id)).filter(Boolean);
  const people = named.length
    ? [named.map((p, i) => [i && i === named.length - 1 ? c.say(W.and) : null, c.name(p)]),
      d.extraMen || d.extraWomen ? [c.say(W.and), peopleOf(c, d.extraMen, d.extraWomen)] : null]
    : peopleOf(c, d.men, d.women);
  return [
    P("P19"), people,
    c.say(W.from), endPiece(c, d.from, d.fromAddress?.address), c.say(W.to), endPiece(c, d.to, d.toAddress?.address),
    d.pickupMinute != null ? [c.say(W.at), timeOf(c, d.pickupMinute)] : c.say("יעצט"),
    d.returnMinute != null ? [c.say(W.and), c.say(W.back), c.say(W.at), timeOf(c, d.returnMinute)] : null,
    P("P20"),
  ];
}

const REFUSALS = {
  no_seats: "P23", no_time: "P23", too_far: "P26", in_past: "P24", not_today: "P24", return_before_pickup: "P24",
  not_registered: "P02",
};
// Refusals about the hours say today's hours.
const HOURS_REFUSALS = ["closed", "outside_hours", "return_outside_hours"];
function refusalOf(c, code) {
  if (HOURS_REFUSALS.includes(code)) return hoursToday(c);
  if (code === "in_past" || code === "not_today") return [P("P24"), hoursToday(c)];
  return P(REFUSALS[code] || "P42");
}

async function book(c) {
  const d = c.st.draft;
  const input = {
    phone: c.phone.number, passengerId: d.passengerId || null, riderName: "", riders: namedIds(d), men: d.men, women: d.women,
    together: !!d.together,
    pickup: d.from ? { placeId: d.from } : d.fromAddress, dropoff: d.to ? { placeId: d.to } : d.toAddress, pickupMinute: d.pickupMinute ?? null, window: d.window,
    returnMinute: d.returnMinute ?? undefined,
  };
  const r = await bookRide(c.db, c.travel, input, c.now, c.settings, `phone:${c.phone.number}`);
  if (r.ok) {
    c.st.draft = null;
    for (const b of r.bookings) c.notify?.(b, "booked");
    return end([P(driverAvailable(c.db, c.now) ? "P21" : "P22")]);
  }
  const refusal = refusalOf(c, r.errors[0]);
  if (r.suggestions?.length) {
    c.st.offer = r.suggestions[0];
    return ask("offer", [refusal, P("P27"), timeOf(c, c.st.offer), P("P27b")]);
  }
  return end([refusal]);
}

const STEPS = {
  start(c) {
    c.st.tries = {};
    const waiting = c.db
      .prepare(`SELECT d.booking_id FROM deliveries d JOIN bookings b ON b.id = d.booking_id WHERE d.phone = ? AND d.kind = 'reminder'
        AND d.status = 'no_answer' AND b.status = 'accepted' AND b.confirmed_by_passenger = 0 AND b.day = ? ORDER BY d.id DESC LIMIT 1`)
      .get(c.from, today(c).day);
    if (waiting) {
      c.st.reminder = waiting.booking_id;
      return ask("reminder_in", [P("P01"), P("P05")]);
    }
    // A schedule change today: say it right away (no rides today, or today's other hours).
    return ask("menu", [P("P01"), c.settings.scheduleChanged ? hoursToday(c) : null, MENU]);
  },
  reminder_in(c) {
    if (c.keys === "1" && c.st.reminder) {
      c.db.prepare("UPDATE bookings SET confirmed_by_passenger = 1, updated_at = ? WHERE id = ?").run(nowIso(), c.st.reminder);
      audit(c.db, `phone:${c.from}`, "confirmed", c.st.reminder);
      return ask("menu", [P("P30a"), MENU]);
    }
    return ask("menu", MENU);
  },
  menu(c) {
    if (c.keys === "1") {
      settle(c, "menu");
      if (c.settings.closed) return ask("menu", [P("P49"), MENU]);
      c.st.draft = { men: 0, women: 0 };
      // The "#" tip only for a phone's first few bookings: after that the caller knows it, and it is one less thing to hear.
      const booked = c.db.prepare("SELECT count(*) AS n FROM bookings WHERE booked_by_phone = ?").get(c.phone.number).n;
      const tip = booked < TIP_BOOKINGS ? P("P67") : null;
      const first = startRide(c) || ask("from", Q.from());
      return { ...first, play: [tip, first.play] };
    }
    if (c.keys === "6") {
      settle(c, "menu");
      return listen("add_say", [P("P56")]);
    }
    if (c.keys === "2") return myRides(c);
    if (c.keys === "3") return cancelList(c);
    if (c.keys === "4") {
      settle(c, "menu");
      return ask("menu", [scheduleSpeech(c), MENU]);
    }
    if (c.keys === "5") {
      settle(c, "menu");
      return ask("menu", [messagesSpeech(c), MENU]);
    }
    if (c.keys === "9") return ask("menu", MENU);
    return retry(c, "menu", MENU);
  },
  // "More options" at the read-back: 1 more people, 2 a ride back, 3 for someone else, 0 back to the read-back.
  more(c) {
    const d = c.st.draft;
    if (!d) return ask("menu", MENU);
    d.editing = true;
    if (c.keys === "0") return ask("confirm", readBack(c));
    if (c.keys === "1") {
      d.with = [];
      d.choices = null;
      if (!namedIds(d).length) return ask("men", Q.men());
      return askWith(c);
    }
    if (c.keys === "2") return ask("ret_time", Q.ret_time(), 4);
    if (c.keys === "3") {
      if (!members(c).length) return ask("men", Q.men());
      return ask("who_pick", whoPick(c), members(c).length > 9 ? 2 : 1);
    }
    return retry(c, "more", Q.more());
  },
  who(c) {
    if (c.keys === "1" || (c.keys === "2" && !members(c).length)) {
      c.st.draft.passengerId = c.phone.passenger_id || null;
      return askWith(c);
    }
    if (c.keys === "2") return ask("who_pick", whoPick(c), members(c).length > 9 ? 2 : 1);
    return retry(c, "who", Q.who());
  },
  who_pick(c) {
    const list = members(c);
    const p = list[Number(c.keys) - 1];
    if (!p) return retry(c, "who_pick", whoPick(c), list.length > 9 ? 2 : 1);
    const d = c.st.draft;
    d.passengerId = p.id;
    d.with = (d.with || []).filter((id) => id !== p.id);
    d.choices = null;
    setPeople(c, d.extraMen || 0, d.extraWomen || 0);
    return onward(c, "from");
  },
  with(c) {
    const d = c.st.draft;
    if (!d) return ask("menu", MENU);
    if (c.keys === "*") return ask("with", [withSpeech(c), P("P61")], withKeys(c));
    if (/^0+$/.test(c.keys)) {
      settle(c, "with");
      return afterWith(c);
    }
    const id = withChoices(c)[Number(c.keys) - 1];
    const p = id && passenger(c, id);
    if (!p || namedIds(d).includes(id)) return retry(c, "with", Q.with(), withKeys(c));
    settle(c, "with");
    d.with = [...(d.with || []), id];
    if (namedIds(d).length >= 7 || !withList(c).length) return afterWith(c);
    return ask("with", [c.name(p), c.say(W.added), P("P61")], withKeys(c));
  },
  extra(c) {
    if (c.keys === "1") return ask("extra_men", Q.extra_men());
    if (c.keys === "2") {
      setPeople(c, 0, 0);
      return afterPeople(c);
    }
    return retry(c, "extra", Q.extra());
  },
  extra_men(c) {
    const n = Number(c.keys);
    if (c.keys === "" || !(n >= 0 && n <= 7)) return retry(c, "extra_men", Q.extra_men());
    c.st.draft.extraMen = n;
    return ask("extra_women", Q.extra_women());
  },
  extra_women(c) {
    const n = Number(c.keys);
    if (c.keys === "" || !(n >= 0 && n <= 6)) return retry(c, "extra_women", Q.extra_women());
    setPeople(c, c.st.draft.extraMen || 0, n);
    if (c.st.draft.men + c.st.draft.women > 7) return end([P("P23")]);
    return afterPeople(c);
  },
  men(c) {
    const n = Number(c.keys);
    if (c.keys === "" || !(n >= 0 && n <= 7)) return retry(c, "men", Q.men());
    c.st.draft.men = n;
    return ask("women", Q.women());
  },
  women(c) {
    const n = Number(c.keys);
    if (c.keys === "" || !(n >= 0 && n <= 6)) return retry(c, "women", Q.women());
    if (n + c.st.draft.men === 0) return retry(c, "men", Q.men());
    c.st.draft.women = n;
    if (c.st.draft.men && n) return ask("together", Q.together());
    return onward(c, "from");
  },
  together(c) {
    if (!["1", "2"].includes(c.keys)) return retry(c, "together", Q.together());
    c.st.draft.together = c.keys === "1";
    return onward(c, "from");
  },
  from: (c) => pickPlace(c, "from", "to"),
  from_code: (c) => placeCode(c, "from", "to"),
  from_say: (c) => heardAddress(c, "from"),
  from_ok: (c) => confirmAddress(c, "from", "to"),
  to_say: (c) => heardAddress(c, "to"),
  to_ok: (c) => confirmAddress(c, "to", "when"),
  from_keep: (c) => keepAddress(c, "from", "to"),
  to_keep: (c) => keepAddress(c, "to", "when"),
  add_say: (c) => heardAddress(c, "add"),
  add_ok: (c) => confirmAddress(c, "add"),
  to: (c) => pickPlace(c, "to", "when"),
  to_code: (c) => placeCode(c, "to", "when"),
  when(c) {
    if (c.keys === "1") {
      if (!fitsToday(c, today(c).minute)) return end([hoursToday(c)]);
      c.st.draft.pickupMinute = null;
      c.st.draft.window = WINDOW;
      return toReadBack(c);
    }
    if (c.keys === "2") return ask("time", Q.time(), 4);
    return retry(c, "when", Q.when());
  },
  time(c) {
    const m = keypadTime(c.keys, c.settings);
    if (m == null) return retry(c, "time", Q.time(), 4);
    if (!fitsToday(c, m)) return retryBecause(c, "time", hoursToday(c), Q.time(), 4);
    c.st.draft.pickupMinute = m;
    c.st.draft.window = WINDOW;
    return toReadBack(c);
  },
  ret(c) {
    if (c.keys === "1") return ask("ret_time", Q.ret_time(), 4);
    if (c.keys === "2") {
      c.st.draft.returnMinute = null;
      return ask("confirm", readBack(c));
    }
    return retry(c, "ret", Q.ret());
  },
  ret_time(c) {
    const m = keypadTime(c.keys, c.settings);
    if (m == null) return retry(c, "ret_time", Q.ret_time(), 4);
    if (!fitsToday(c, m)) return retryBecause(c, "ret_time", hoursToday(c), Q.ret_time(), 4);
    c.st.draft.returnMinute = m;
    return ask("confirm", readBack(c));
  },
  // The read-back: 1 book it, 2 more options, 3 start over.
  confirm(c) {
    if (!c.st.draft) return ask("menu", MENU);
    if (c.keys === "1") return book(c);
    if (c.keys === "2") {
      settle(c, "confirm");
      return ask("more", Q.more());
    }
    if (c.keys === "3") {
      c.st.draft = { men: 0, women: 0 };
      return startRide(c) || ask("from", Q.from());
    }
    return retry(c, "confirm", readBack(c));
  },
  offer(c) {
    if (c.keys === "1" && c.st.draft && c.st.offer != null) {
      c.st.draft.pickupMinute = c.st.offer;
      c.st.offer = null;
      return book(c);
    }
    return end([]);
  },
  rides_menu(c) {
    if (c.keys === "0") return ask("menu", MENU);
    if (c.keys === "2") {
      const list = (c.st.list || []).map((id) => getBooking(c.db, id)).filter((b) => b && CANCELLABLE.includes(b.status));
      if (list.length === 1) return changeRide(c, list[0]);
      if (!list.length) return ask("menu", [P("P28"), MENU]);
      return ask("change_which", Q.change_which(), list.length > 9 ? 2 : 1);
    }
    return retry(c, "rides_menu", Q.rides_menu());
  },
  change_which(c) {
    const b = getBooking(c.db, (c.st.list || [])[Number(c.keys) - 1]);
    if (!b || !CANCELLABLE.includes(b.status)) return retry(c, "change_which", Q.change_which(), (c.st.list || []).length > 9 ? 2 : 1);
    return changeRide(c, b);
  },
  async change_code(c) {
    if (c.keys === "0") return ask("change_code", [placeList(c), P("P13")], CODE_KEYS);
    const matches = /^\d+$/.test(c.keys) ? codeMatches(c.db, c.keys, c.phone.household_id) : [];
    if (!matches.length) return retry(c, "change_code", Q.change_code(), CODE_KEYS);
    if (matches.length > 1) return askChoice(c, "change", matches);
    return changePickup(c, matches[0]);
  },
  from_choose: (c) => chosen(c, "from", (place) => setPlace(c, "from", place, "to")),
  to_choose: (c) => chosen(c, "to", (place) => setPlace(c, "to", place, "when")),
  change_choose: (c) => chosen(c, "change", (place) => changePickup(c, place)),
  cancel_which(c) {
    const b = getBooking(c.db, (c.st.list || [])[Number(c.keys) - 1]);
    if (!b || !CANCELLABLE.includes(b.status)) return retry(c, "cancel_which", Q.cancel_which(), (c.st.list || []).length > 9 ? 2 : 1);
    c.st.cancelling = b.id;
    return ask("cancel_confirm", Q.cancel_confirm());
  },
  async cancel_confirm(c) {
    if (c.keys === "2") return ask("menu", MENU);
    if (c.keys !== "1") return retry(c, "cancel_confirm", Q.cancel_confirm());
    const b = getBooking(c.db, c.st.cancelling);
    const r = b ? changeStatus(c.db, b.id, "cancel", `phone:${c.from}`, c.now, c.settings) : { ok: false };
    if (r.ok && b.status === "accepted") await refreshDay(c.db, c.travel, b.day, c.settings, c.now);
    return ask("menu", [P(r.ok ? "P34" : "P42"), MENU]);
  },
};

function pickPlace(c, which, next) {
  if (c.keys === "1") {
    const home = homeOf(c);
    if (home) return setPlace(c, which, home, next);
    return ask(`${which}_code`, Q[`${which}_code`](), CODE_KEYS);
  }
  if (c.keys === "2") return ask(`${which}_code`, Q[`${which}_code`](), CODE_KEYS);
  if (c.keys === "3") return listen(`${which}_say`, [P("P56")]);
  return retry(c, which, Q[which]());
}

// ---------- a one-time address: said out loud, found on the map, read back, not saved to the family's places ----------
async function heardAddress(c, which) {
  const text = String(c.transcript || "").trim();
  const again = (why) => {
    c.st.tries ||= {};
    c.st.tries[`${which}_say`] = (c.st.tries[`${which}_say`] || 0) + 1;
    // After two misses, back to choosing a saved place.
    if (c.st.tries[`${which}_say`] > TRIES) { settle(c, `${which}_say`); return which === "add" ? ask("menu", [why, MENU]) : ask(which, [why, Q[which]()]); }
    return listen(`${which}_say`, [why, P("P56")]);
  };
  if (!text) return again(P("P43"));
  const found = c.travel.lookup ? await c.travel.lookup(text) : { status: "unknown" };
  if (found.status === "not_found" || found.km > AREA_KM) return again(P("P59"));
  settle(c, `${which}_say`);
  c.st.heard = found.status === "found"
    ? { address: found.formatted, lat: found.lat, lng: found.lng }
    : { address: text }; // no map key: the driver gets the words as said
  return ask(`${which}_ok`, [P("P57"), { say: spokenAddress(c.st.heard.address), language: "english" }, P("P58")]);
}
function confirmAddress(c, which, next) {
  if (c.keys === "2") return listen(`${which}_say`, [P("P56")]);
  if (c.keys !== "1" || !c.st.heard) return retry(c, `${which}_ok`, [P("P58")]);
  // Just adding an address (menu key 6): save it and say its code.
  if (which === "add") return ask("menu", [saveHeard(c), MENU]);
  return ask(`${which}_keep`, [P("P65")]);
}
// Save the address for everyone, or use it for this ride only.
function keepAddress(c, which, next) {
  if (!c.st.heard || !c.st.draft) return ask("menu", MENU);
  if (c.keys === "1") {
    const said = saveHeard(c, (id) => { c.st.draft[which] = id; c.st.draft[`${which}Address`] = null; });
    return ask(next, [said, Q[next]()]);
  }
  if (c.keys !== "2") return retry(c, `${which}_keep`, [P("P65")]);
  c.st.draft[which] = null;
  c.st.draft[`${which}Address`] = c.st.heard;
  c.st.heard = null;
  return ask(next, Q[next]());
}
// Save what the caller said as a shared place; its code is the house number when free. Returns what to say.
function saveHeard(c, use = () => {}) {
  const h = c.st.heard;
  const r = savePlace(c.db, { name: spokenAddress(h.address), address: h.address, lat: h.lat, lng: h.lng, kind: "other" }, `phone:${c.from}`);
  c.st.heard = null;
  if (!r.ok) return P("P42");
  use(r.id);
  return [P("P66"), digitsOf(c, r.code)];
}
async function changePickup(c, place) {
  const b = getBooking(c.db, c.st.changing);
  if (!b || !CANCELLABLE.includes(b.status) || !canChangePickup(today(c).minute, b.pickup_minute, c.settings)) return end([P("P36")]);
  c.db.prepare(`UPDATE bookings SET pickup_place_id = ?, pickup_address = ?, pickup_lat = ?, pickup_lng = ?, updated_at = ? WHERE id = ?`)
    .run(place.id, place.address, place.lat, place.lng, nowIso(), b.id);
  audit(c.db, `phone:${c.from}`, "pickup_changed", b.id, { place: place.id });
  if (b.status === "accepted") await refreshDay(c.db, c.travel, b.day, c.settings, c.now);
  return ask("menu", [P("P46"), MENU]);
}

// Two or more places with the pressed code (and none of them the caller's family's): read their names, press 1, 2, ...
function askChoice(c, which, places) {
  c.st.choices = places.slice(0, 9).map((p) => p.id);
  return ask(`${which}_choose`, choiceList(c));
}
function choiceList(c) {
  return (c.st.choices || []).map((id, i) => [c.name(placeRow(c, id)), c.say(W.press), numberOf(c, i + 1)]);
}
function chosen(c, which, then) {
  const place = placeRow(c, (c.st.choices || [])[Number(c.keys) - 1]);
  if (!place || !place.active) return retry(c, `${which}_choose`, choiceList(c));
  settle(c, `${which}_choose`);
  c.st.choices = null;
  return then(place);
}

function placeCode(c, which, next) {
  if (c.keys === "0") return ask(`${which}_code`, [placeList(c), P("P13")], CODE_KEYS);
  if (normalCode(c.keys) === SAY_CODE) return listen(`${which}_say`, [P("P56")]); // 100: say a new address
  const matches = /^\d+$/.test(c.keys) ? codeMatches(c.db, c.keys, c.phone.household_id) : [];
  if (!matches.length) return retry(c, `${which}_code`, Q[`${which}_code`](), CODE_KEYS);
  if (matches.length > 1) return askChoice(c, which, matches);
  return setPlace(c, which, matches[0], next);
}
function setPlace(c, which, place, next) {
  if (which === "to" && place.id === c.st.draft.from) return retry(c, "to", Q.to());
  c.st.draft[which] = place.id;
  c.st.draft[`${which}Address`] = null;
  return ask(next, Q[next]());
}

function myRides(c) {
  const list = ridesToday(c, ACTIVE);
  c.st.list = list.map((b) => b.id);
  if (!list.length) return ask("menu", [P("P28"), MENU]);
  return ask("rides_menu", [list.map((b, i) => rideItems(c, b, i)), P("P35")]);
}
function cancelList(c) {
  const list = ridesToday(c, CANCELLABLE);
  c.st.list = list.map((b) => b.id);
  if (!list.length) return ask("menu", [P("P28"), MENU]);
  return ask("cancel_which", [list.map((b, i) => rideItems(c, b, i)), P("P32")], list.length > 9 ? 2 : 1);
}
function changeRide(c, b) {
  if (!canChangePickup(today(c).minute, b.pickup_minute, c.settings)) return end([P("P36")]);
  c.st.changing = b.id;
  return ask("change_code", Q.change_code(), CODE_KEYS);
}

// ---------- outgoing ----------
async function outbound(c) {
  const d = c.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(c.call.delivery_id);
  if (!d) return end([]);
  if (d.status !== "answered") {
    c.db.prepare("UPDATE deliveries SET status = 'answered', updated_at = ? WHERE id = ?").run(nowIso(), d.id);
  }
  const b = d.booking_id ? getBooking(c.db, d.booking_id) : null;
  const payload = JSON.parse(d.payload || "{}");
  const first = /^out:/.test(c.step);
  const key = (k) => c.db.prepare("UPDATE deliveries SET note = ?, updated_at = ? WHERE id = ?").run(`pressed ${k}`, nowIso(), d.id);
  const keysStep = `out_keys:${d.id}`;
  const eta = b ? b.eta_minute ?? b.pickup_minute : null;

  switch (d.kind) {
    case "announcement": {
      const a = c.db.prepare("SELECT * FROM announcements WHERE id = ?").get(d.announcement_id);
      return end([P("P44"), a?.recording ? { audio: `${c.base}/audio/${a.recording}` } : { say: a?.text || "" }]);
    }
    case "accepted":
      return end([P("P39"), riderPiece(c, b), P("P31"), timeOf(c, eta)]);
    case "not_taken":
      return end([P("P40"), riderPiece(c, b)]);
    case "late":
      return end([P("P45"), timeOf(c, payload.minute ?? eta), riderPiece(c, b)]);
    case "cancelled":
      return end([P("P34"), riderPiece(c, b)]);
    case "reminder": {
      const question = [P("P37a"), riderPiece(c, b), P("P37b")];
      if (first) return ask(keysStep, question);
      if (c.keys === "1") {
        key("1");
        c.db.prepare("UPDATE bookings SET confirmed_by_passenger = 1, updated_at = ? WHERE id = ?").run(nowIso(), b.id);
        audit(c.db, `phone:${c.from}`, "confirmed", b.id);
        return end([P("P30a")]);
      }
      if (c.keys === "2") {
        key("2");
        const r = changeStatus(c.db, b.id, "cancel", `phone:${c.from}`, c.now, c.settings);
        if (r.ok) await refreshDay(c.db, c.travel, b.day, c.settings, c.now);
        return end([P("P34")]);
      }
      return retry(c, keysStep, question);
    }
    case "time_change": {
      const newMinute = payload.newMinute ?? b?.proposed_minute;
      const oldMinute = payload.oldMinute ?? b?.pickup_minute;
      const question = [P("P38a"), riderPiece(c, b), timeOf(c, newMinute), c.say(W.instead), timeOf(c, oldMinute), P("P38b")];
      if (first) return ask(keysStep, question);
      if (!b || b.status !== "proposed") return end([]);
      if (c.keys === "1") {
        key("1");
        c.db.prepare("UPDATE bookings SET pickup_minute = ?, updated_at = ? WHERE id = ?").run(newMinute, nowIso(), b.id);
        audit(c.db, `phone:${c.from}`, "agreed_time", b.id, { minute: newMinute });
        const r = await acceptRide(c.db, c.travel, b.id, b.driver_id, c.settings, c.now);
        if (r.ok) return end([P("P39"), P("P31"), timeOf(c, r.booking.eta_minute ?? newMinute)]);
        c.db.prepare("UPDATE bookings SET status = 'pending', updated_at = ? WHERE id = ?").run(nowIso(), b.id);
        return end([P("P21")]);
      }
      if (c.keys === "2") {
        key("2");
        changeStatus(c.db, b.id, "cancel", `phone:${c.from}`, c.now, c.settings);
        audit(c.db, `phone:${c.from}`, "declined_time", b.id);
        return end([P("P34")]);
      }
      return retry(c, keysStep, question);
    }
    default:
      return end([]);
  }
}
