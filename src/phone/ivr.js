// The phone menu: one answer for every step of every call (POST /fonory/step). The flow is the "Incoming call" and
// "Outgoing calls" sections of the phone setup doc. Fonory sends { call_id, from, direction, step, keys }; we answer
// { play: [{ prompt } | { audio } | { say }], gather?: { step, max_keys, timeout_s }, hangup }.
// Where the caller is (the ride being ordered, the list just read out) is kept per call in phone_calls.
import { nowIso, audit } from "../db.js";
import { approvedPhone, changeStatus, getBooking } from "../bookings.js";
import { bookRide, acceptRide, refreshDay } from "../dispatch.js";
import { keypadTime, localParts, canChangePickup } from "../rules.js";
import { W, numberWords, timePieces } from "./words.js";
import { piece, namePiece } from "./audio.js";
import { driverAvailable } from "../driver.js";

const ACTIVE = ["pending", "proposed", "accepted", "picked_up"];
const CANCELLABLE = ["pending", "proposed", "accepted"];
const TRIES = 2;

const P = (code) => ({ prompt: code });

// ctx: { db, travel, settings, now, base, notify(booking, kind, payload) }
export async function phoneStep(ctx, body) {
  const { db } = ctx;
  const callId = String(body.call_id || "");
  const from = normalize(body.from);
  const step = String(body.step || "start");
  const keys = String(body.keys ?? "").replace(/[^0-9*#]/g, "").replace(/#$/, "");
  if (!callId || !from) return { play: [P("P03")], hangup: true };

  let call = db.prepare("SELECT * FROM phone_calls WHERE call_id = ?").get(callId);
  if (!call) {
    const out = /^out:(\d+)$/.exec(step);
    db.prepare("INSERT INTO phone_calls (call_id, phone, direction, delivery_id, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      callId, from, out ? "outbound" : body.direction === "outbound" ? "outbound" : "inbound", out ? Number(out[1]) : null, nowIso(), nowIso());
    call = db.prepare("SELECT * FROM phone_calls WHERE call_id = ?").get(callId);
  }
  const st = JSON.parse(call.state || "{}");
  const c = { ...ctx, call, st, keys, step, from, say: (t) => piece(db, ctx.base, t), name: (row) => namePiece(db, ctx.base, row) };
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
const end = (play) => ({ play: [play, P("P41")], hangup: true });

// A wrong key or none: say so and ask again, twice at most, then say goodbye.
function retry(c, step, question, maxKeys = 1) {
  c.st.tries ||= {};
  c.st.tries[step] = (c.st.tries[step] || 0) + 1;
  if (c.st.tries[step] > TRIES) return end([]);
  return ask(step, [P(c.keys ? "P42" : "P43"), question], maxKeys);
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
function riderPiece(c, b) {
  const p = b.passenger_id ? c.db.prepare("SELECT * FROM passengers WHERE id = ?").get(b.passenger_id) : null;
  return p ? c.name(p) : b.rider_name ? c.say(b.rider_name) : null;
}
function peopleOf(c, men, women) {
  return [men ? [numberOf(c, men), c.say(men === 1 ? W.man : W.men)] : null, men && women ? c.say(W.and) : null, women ? [numberOf(c, women), c.say(women === 1 ? W.woman : W.women)] : null];
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
    c.say(W.from), c.name(placeRow(c, b.pickup_place_id)), c.say(W.to), c.name(placeRow(c, b.dropoff_place_id)),
    P("P31"), timeOf(c, b.eta_minute ?? b.pickup_minute),
    P(["accepted", "picked_up"].includes(b.status) ? "P30a" : "P30b"),
  ];
}
function placesFor(c) {
  return c.db
    .prepare("SELECT * FROM places WHERE active = 1 AND (household_id IS NULL OR household_id = ?) ORDER BY code")
    .all(c.phone.household_id);
}
function homeOf(c) {
  return c.db
    .prepare("SELECT * FROM places WHERE active = 1 AND household_id = ? ORDER BY kind != 'home', code LIMIT 1")
    .get(c.phone.household_id);
}
function placeList(c) {
  return placesFor(c).map((p) => [digitsOf(c, p.code), c.name(p)]);
}

// Each question, so it can be asked again.
const Q = {
  menu: () => MENU,
  who: () => [P("P06")],
  men: () => [P("P08")],
  women: () => [P("P09")],
  together: () => [P("P10")],
  from: () => [P("P11")],
  to: () => [P("P12")],
  from_code: () => [P("P13"), P("P14")],
  to_code: () => [P("P13"), P("P14")],
  change_code: () => [P("P13"), P("P14")],
  when: () => [P("P15")],
  time: () => [P("P16")],
  ret_time: () => [P("P16")],
  window: () => [P("P17")],
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

function readBack(c) {
  const d = c.st.draft;
  const pass = d.passengerId ? c.db.prepare("SELECT * FROM passengers WHERE id = ?").get(d.passengerId) : null;
  return [
    P("P19"), pass ? c.name(pass) : null, peopleOf(c, d.men, d.women),
    c.say(W.from), c.name(placeRow(c, d.from)), c.say(W.to), c.name(placeRow(c, d.to)),
    d.pickupMinute != null ? [c.say(W.at), timeOf(c, d.pickupMinute)] : c.say("יעצט"),
    d.returnMinute != null ? [c.say(W.and), c.say(W.back), c.say(W.at), timeOf(c, d.returnMinute)] : null,
    P("P20"),
  ];
}

const REFUSALS = {
  no_seats: "P23", no_time: "P23", too_far: "P26", outside_hours: "P24", in_past: "P24", not_today: "P24",
  return_outside_hours: "P24", return_before_pickup: "P24", not_registered: "P02",
};

async function book(c) {
  const d = c.st.draft;
  const input = {
    phone: c.phone.number, passengerId: d.passengerId || null, riderName: "", men: d.men, women: d.women, together: !!d.together,
    pickup: { placeId: d.from }, dropoff: { placeId: d.to }, pickupMinute: d.pickupMinute ?? null, window: d.window,
    returnMinute: d.returnMinute ?? undefined,
  };
  const r = await bookRide(c.db, c.travel, input, c.now, c.settings, `phone:${c.phone.number}`);
  if (r.ok) {
    c.st.draft = null;
    for (const b of r.bookings) c.notify?.(b, "booked");
    return end([P(driverAvailable(c.db, c.now) ? "P21" : "P22")]);
  }
  const refusal = P(REFUSALS[r.errors[0]] || "P42");
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
    return ask("menu", [P("P01"), MENU]);
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
      c.st.draft = { men: 0, women: 0 };
      return ask("who", Q.who());
    }
    if (c.keys === "2") return myRides(c);
    if (c.keys === "3") return cancelList(c);
    if (c.keys === "9") return ask("menu", MENU);
    return retry(c, "menu", MENU);
  },
  who(c) {
    if (c.keys === "1" || (c.keys === "2" && !members(c).length)) {
      c.st.draft.passengerId = c.phone.passenger_id || null;
      return ask("men", Q.men());
    }
    if (c.keys === "2") return ask("who_pick", whoPick(c), members(c).length > 9 ? 2 : 1);
    return retry(c, "who", Q.who());
  },
  who_pick(c) {
    const list = members(c);
    const p = list[Number(c.keys) - 1];
    if (!p) return retry(c, "who_pick", whoPick(c), list.length > 9 ? 2 : 1);
    c.st.draft.passengerId = p.id;
    return ask("men", Q.men());
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
    return ask("from", Q.from());
  },
  together(c) {
    if (!["1", "2"].includes(c.keys)) return retry(c, "together", Q.together());
    c.st.draft.together = c.keys === "1";
    return ask("from", Q.from());
  },
  from: (c) => pickPlace(c, "from", "to"),
  from_code: (c) => placeCode(c, "from", "to"),
  to: (c) => pickPlace(c, "to", "when"),
  to_code: (c) => placeCode(c, "to", "when"),
  when(c) {
    if (c.keys === "1") {
      c.st.draft.pickupMinute = null;
      return ask("window", Q.window());
    }
    if (c.keys === "2") return ask("time", Q.time(), 4);
    return retry(c, "when", Q.when());
  },
  time(c) {
    const m = keypadTime(c.keys);
    if (m == null) return retry(c, "time", Q.time(), 4);
    c.st.draft.pickupMinute = m;
    return ask("window", Q.window());
  },
  window(c) {
    if (!["1", "2"].includes(c.keys)) return retry(c, "window", Q.window());
    c.st.draft.window = c.keys === "1" ? 15 : 30;
    return ask("ret", Q.ret());
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
    const m = keypadTime(c.keys);
    if (m == null) return retry(c, "ret_time", Q.ret_time(), 4);
    c.st.draft.returnMinute = m;
    return ask("confirm", readBack(c));
  },
  confirm(c) {
    if (!c.st.draft) return ask("menu", MENU);
    if (c.keys === "1") return book(c);
    if (c.keys === "2") {
      c.st.draft = { men: 0, women: 0 };
      return ask("who", Q.who());
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
    if (c.keys === "0") return ask("change_code", [placeList(c), P("P13")], 3);
    const place = placesFor(c).find((p) => p.code === c.keys.padStart(2, "0"));
    const b = getBooking(c.db, c.st.changing);
    if (!place) return retry(c, "change_code", Q.change_code(), 3);
    if (!b || !CANCELLABLE.includes(b.status) || !canChangePickup(today(c).minute, b.pickup_minute, c.settings)) return end([P("P36")]);
    c.db.prepare(`UPDATE bookings SET pickup_place_id = ?, pickup_address = ?, pickup_lat = ?, pickup_lng = ?, updated_at = ? WHERE id = ?`)
      .run(place.id, place.address, place.lat, place.lng, nowIso(), b.id);
    audit(c.db, `phone:${c.from}`, "pickup_changed", b.id, { place: place.id });
    if (b.status === "accepted") await refreshDay(c.db, c.travel, b.day, c.settings, c.now);
    return ask("menu", [P("P46"), MENU]);
  },
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
    return ask(`${which}_code`, Q[`${which}_code`](), 3);
  }
  if (c.keys === "2") return ask(`${which}_code`, Q[`${which}_code`](), 3);
  return retry(c, which, Q[which]());
}
function placeCode(c, which, next) {
  if (c.keys === "0") return ask(`${which}_code`, [placeList(c), P("P13")], 3);
  const place = placesFor(c).find((p) => p.code === c.keys.padStart(2, "0"));
  if (!place) return retry(c, `${which}_code`, Q[`${which}_code`](), 3);
  return setPlace(c, which, place, next);
}
function setPlace(c, which, place, next) {
  if (which === "to" && place.id === c.st.draft.from) return retry(c, "to", Q.to());
  c.st.draft[which] = place.id;
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
  return ask("change_code", Q.change_code(), 3);
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
