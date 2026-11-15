// Announcements: one message from the admin to everyone (or one household), delivered to each approved phone the way
// that phone is set: a text, a voice call, or both. The call plays the admin's recording when there is one, otherwise
// the text in the Yiddish voice. Deliveries are queued here; notify.js sends them through Fonory.
// Three ways to send one (Shloime, 2026-11-15): the admin on the dashboard, the driver in the app (More), or a text to
// the line from a number the admin approved as a sender (message_senders).
import { audit, newId, nowIso } from "./db.js";

export function createAnnouncement(db, { text, recording = null, audience = "all" }, by) {
  if (!text || !String(text).trim()) return { ok: false, error: "Write the message first." };
  // The call reads at most 500 letters.
  if (String(text).trim().length > 500) return { ok: false, error: "The message is too long. Keep it under 500 letters." };
  const phones =
    audience === "all"
      ? db.prepare("SELECT * FROM phones WHERE active = 1").all()
      : db.prepare("SELECT * FROM phones WHERE active = 1 AND household_id = ?").all(audience);
  if (!phones.length) return { ok: false, error: "No approved phones to send to." };
  const id = newId("an");
  const at = nowIso();
  db.prepare("INSERT INTO announcements (id, text, recording, audience, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id, String(text).trim(), recording, audience, by, at);
  const add = db.prepare("INSERT INTO deliveries (announcement_id, phone, channel, kind, updated_at) VALUES (?, ?, ?, 'announcement', ?)");
  for (const p of phones) {
    if (p.notify !== "voice") add.run(id, p.number, "text", at);
    if (p.notify !== "text") add.run(id, p.number, "voice", at);
  }
  audit(db, by, "announcement_created", null, { id, audience, phones: phones.length });
  return { ok: true, id, phones: phones.length, voiceSkipped: 0 };
}

export function listAnnouncements(db) {
  return db
    .prepare(`SELECT a.*,
      (SELECT count(*) FROM deliveries d WHERE d.announcement_id = a.id) AS deliveries,
      (SELECT count(*) FROM deliveries d WHERE d.announcement_id = a.id AND d.status IN ('sent', 'answered')) AS reached,
      (SELECT count(*) FROM deliveries d WHERE d.announcement_id = a.id AND d.status IN ('no_answer', 'failed')) AS not_reached
      FROM announcements a ORDER BY a.created_at DESC LIMIT 100`)
    .all()
    .map((a) => ({ ...a, from: senderLabel(db, a.created_by) }));
}

// What a caller can hear again on the phone (menu key 5): the messages sent to everyone or to their family in the last
// `days` days, newest first.
export const HEAR_DAYS = 14;
export const HEAR_MAX = 5;
export function recentAnnouncements(db, householdId, now = new Date(), { days = HEAR_DAYS, limit = HEAR_MAX } = {}) {
  const since = new Date(now.getTime() - days * 864e5).toISOString();
  return db
    .prepare("SELECT * FROM announcements WHERE (audience = 'all' OR audience = ?) AND created_at >= ? ORDER BY created_at DESC LIMIT ?")
    .all(householdId, since, limit);
}

// Who sent it, for the dashboard: "admin:a@b.com" → the email, "driver:drv1" → the driver's name, "text:+1845…" → the
// sender's name and number.
export function senderLabel(db, by) {
  const [kind, who] = String(by || "").split(/:(.*)/s);
  if (kind === "admin") return who;
  if (kind === "driver") return `Driver ${db.prepare("SELECT name FROM drivers WHERE id = ?").get(who)?.name || ""}`.trim();
  if (kind === "text") {
    const s = db.prepare("SELECT name FROM message_senders WHERE number = ?").get(who);
    return `Text from ${s ? `${s.name} (${who})` : who}`;
  }
  return by;
}

// ---------- sending by text ----------
export function listSenders(db) {
  return db.prepare("SELECT * FROM message_senders ORDER BY name").all();
}
export function addSender(db, number, name, by) {
  if (!number) return { ok: false, error: "Write a 10-digit phone number." };
  if (!String(name || "").trim()) return { ok: false, error: "Write whose number it is." };
  db.prepare("INSERT INTO message_senders (number, name, added_at) VALUES (?, ?, ?) ON CONFLICT(number) DO UPDATE SET name = excluded.name")
    .run(number, String(name).trim(), nowIso());
  audit(db, by, "sender_added", null, { number });
  return { ok: true };
}
export function removeSender(db, number, by) {
  const r = db.prepare("DELETE FROM message_senders WHERE number = ?").run(number);
  if (!r.changes) return { ok: false, error: "That number isn't on the list." };
  audit(db, by, "sender_removed", null, { number });
  return { ok: true };
}

// A text that came in to the line. From an approved sender, its words go to everyone, and the sender gets a short
// text back saying how many phones it went to. From anyone else it is ignored (kept in the log only).
export function textIn(db, from, text) {
  const sender = from && db.prepare("SELECT * FROM message_senders WHERE number = ?").get(from);
  if (!sender) return { ok: false, error: "not an approved sender" };
  const r = createAnnouncement(db, { text }, `text:${from}`);
  const reply = r.ok ? `Sent to everyone (${r.phones} phones).` : `Not sent: ${r.error}`;
  db.prepare("INSERT INTO deliveries (phone, channel, kind, body, updated_at) VALUES (?, 'text', 'sender_reply', ?, ?)").run(from, reply, nowIso());
  return r;
}
