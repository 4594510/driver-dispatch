// Announcements: one message from the admin to everyone (or one household), delivered to each approved phone the way
// that phone is set: a text, a voice call playing the admin's recording, or both. Deliveries are queued here; the Fonory
// connection (stage 4) sends them and records whether each one went through.
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
  let voiceSkipped = 0;
  for (const p of phones) {
    if (p.notify !== "voice") add.run(id, p.number, "text", at);
    if (p.notify !== "text") {
      // A voice call needs the recording; without one, a voice-only phone gets nothing and the admin is told.
      if (recording) add.run(id, p.number, "voice", at);
      else if (p.notify === "voice") voiceSkipped++;
    }
  }
  audit(db, by, "announcement_created", null, { id, audience, phones: phones.length });
  return { ok: true, id, phones: phones.length, voiceSkipped };
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
