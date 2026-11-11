// Announcements: one message from the admin to everyone (or one household), delivered to each approved phone the way
// that phone is set: a text, a voice call, or both. The call plays the admin's recording when there is one, otherwise
// the text in the Yiddish voice. Deliveries are queued here; notify.js sends them through Fonory.
import { audit, newId, nowIso } from "./db.js";

export function createAnnouncement(db, { text, recording = null, audience = "all" }, by) {
  if (!text || !String(text).trim()) return { ok: false, error: "Write the message first." };
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
    .all();
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
