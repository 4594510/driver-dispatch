// Messages to callers (the "Outgoing calls and texts" table of the phone setup doc): each goes to the phone that
// booked the ride, as a text, a call or both, by that phone's setting. They wait in deliveries and go out through
// Fonory (sendDue); a call nobody answered is tried again for the kinds that need an answer (reminder, time change).
import { audit, nowIso } from "./db.js";
import { localParts, DEFAULT_SETTINGS } from "./rules.js";
import { TEXTS, timeText } from "./phone/words.js";

export const RETRY_KINDS = ["reminder", "time_change"];
export const CALL_TRIES = 3; // the first call and 2 more
const RETRY_MINUTES = 1;
const TEXT_ONLY = ["booked"]; // no call for these
// News about a ride is worth nothing an hour later ("your driver comes in 5 minutes"). Messages that waited longer
// (the phone line wasn't connected, or was down) are dropped, not sent late. Announcements still wait.
export const STALE_MINUTES = 60;

function rideInfo(db, b, payload = {}) {
  const p = b.passenger_id ? db.prepare("SELECT * FROM passengers WHERE id = ?").get(b.passenger_id) : null;
  const place = (id, address) => {
    const row = id ? db.prepare("SELECT * FROM places WHERE id = ?").get(id) : null;
    return row ? row.spoken || row.name : address;
  };
  return {
    name: p ? p.spoken || p.name : b.rider_name || "",
    from: place(b.pickup_place_id, b.pickup_address),
    to: place(b.dropoff_place_id, b.dropoff_address),
    time: timeText(payload.minute ?? b.eta_minute ?? b.pickup_minute),
    oldTime: payload.oldMinute != null ? timeText(payload.oldMinute) : "",
    newTime: payload.newMinute != null ? timeText(payload.newMinute) : "",
  };
}

// Queue a message about a ride. kind: booked | accepted | not_taken | time_change | reminder | late | cancelled.
export function notifyBooking(db, booking, kind, payload = {}, dueAt = nowIso()) {
  const phone = db.prepare("SELECT * FROM phones WHERE number = ? AND active = 1").get(booking.booked_by_phone);
  if (!phone) return 0;
  const add = db.prepare(`INSERT INTO deliveries (booking_id, phone, channel, kind, status, payload, body, due_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`);
  let n = 0;
  if (phone.notify !== "voice") {
    add.run(booking.id, phone.number, "text", kind, JSON.stringify(payload), TEXTS[kind](rideInfo(db, booking, payload)), dueAt, nowIso());
    n++;
  }
  if (phone.notify !== "text" && !TEXT_ONLY.includes(kind)) {
    add.run(booking.id, phone.number, "voice", kind, JSON.stringify(payload), null, dueAt, nowIso());
    n++;
  }
  // A voice-only phone still hears that its ride was taken: the booked text becomes nothing, the accepted call follows.
  return n;
}

// Reminders: a few minutes before the driver should arrive (settings.reminderMinutesBefore), once per ride.
export function queueReminders(db, settings = DEFAULT_SETTINGS, now = new Date()) {
  const here = localParts(now, settings.timeZone);
  const rows = db
    .prepare(`SELECT * FROM bookings b WHERE day = ? AND status = 'accepted' AND confirmed_by_passenger = 0
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.booking_id = b.id AND d.kind = 'reminder')`)
    .all(here.day);
  let n = 0;
  for (const b of rows) {
    const eta = b.eta_minute ?? b.pickup_minute;
    const left = eta - here.minute;
    if (left <= settings.reminderMinutesBefore && left > -settings.driverWaitMinutes) n += notifyBooking(db, b, "reminder", {}, now.toISOString());
  }
  return n;
}

// Send what's due. client: fonoryClient(), or null while Fonory isn't connected (everything waits).
export async function sendDue(db, client, now = new Date(), log = console.warn) {
  db.prepare(`UPDATE deliveries SET status = 'failed', note = 'too old to send', updated_at = ?
    WHERE status = 'queued' AND booking_id IS NOT NULL AND coalesce(due_at, updated_at) < ?`)
    .run(nowIso(), new Date(now.getTime() - STALE_MINUTES * 60000).toISOString());
  if (!client) return 0;
  const rows = db
    .prepare("SELECT * FROM deliveries WHERE status = 'queued' AND (due_at IS NULL OR due_at <= ?) ORDER BY id LIMIT 30")
    .all(now.toISOString());
  let sent = 0;
  for (const d of rows) {
    // Claim it first, so a slow request can't send it twice.
    const claimed = db.prepare("UPDATE deliveries SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'queued'").run(nowIso(), d.id);
    if (!claimed.changes) continue;
    try {
      if (d.channel === "text") {
        let body = d.body;
        if (!body && d.announcement_id) {
          const a = db.prepare("SELECT text FROM announcements WHERE id = ?").get(d.announcement_id);
          body = TEXTS.announcement({ text: a?.text || "" });
        }
        await client.text(d.phone, body);
        db.prepare("UPDATE deliveries SET status = 'sent', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(nowIso(), d.id);
      } else {
        const callId = await client.call(d.phone, `out:${d.id}`);
        db.prepare("UPDATE deliveries SET status = 'calling', call_id = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?").run(callId, nowIso(), d.id);
      }
      sent++;
    } catch (e) {
      const attempts = d.attempts + 1;
      const again = attempts < CALL_TRIES;
      db.prepare("UPDATE deliveries SET status = ?, attempts = ?, note = ?, due_at = ?, updated_at = ? WHERE id = ?").run(
        again ? "queued" : "failed", attempts, String(e.message).slice(0, 300), new Date(now.getTime() + 60000).toISOString(), nowIso(), d.id);
      log("sending failed:", e.message);
    }
  }
  return sent;
}

// How an outgoing call ended (POST /fonory/status). result: answered | completed | no_answer | busy | failed.
export function callEnded(db, callId, result, now = new Date()) {
  db.prepare("UPDATE phone_calls SET result = ?, updated_at = ? WHERE call_id = ?").run(result, nowIso(), callId);
  const d = db.prepare("SELECT * FROM deliveries WHERE call_id = ? ORDER BY id DESC LIMIT 1").get(callId)
    || db.prepare("SELECT d.* FROM deliveries d JOIN phone_calls c ON c.delivery_id = d.id WHERE c.call_id = ?").get(callId);
  if (!d) return null;
  if (["answered", "completed"].includes(result) || d.status === "answered") {
    db.prepare("UPDATE deliveries SET status = 'answered', updated_at = ? WHERE id = ?").run(nowIso(), d.id);
    return "answered";
  }
  const reachable = RETRY_KINDS.includes(d.kind) && d.attempts < CALL_TRIES;
  if (reachable) {
    db.prepare("UPDATE deliveries SET status = 'queued', note = ?, due_at = ?, updated_at = ? WHERE id = ?").run(
      result, new Date(now.getTime() + RETRY_MINUTES * 60000).toISOString(), nowIso(), d.id);
    return "retry";
  }
  db.prepare("UPDATE deliveries SET status = ?, note = ?, updated_at = ? WHERE id = ?").run(result === "failed" ? "failed" : "no_answer", result, nowIso(), d.id);
  // The ride stays as it is; the driver and the dashboard see that the caller wasn't reached.
  if (d.booking_id) audit(db, "system", `${d.kind}_not_reached`, d.booking_id, { result });
  return "given_up";
}
