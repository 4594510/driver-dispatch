// Spoken pieces: what the phone plays for a word, number, name or place that isn't a fixed prompt.
//
// A piece is a saved recording (clips table, made with the Yiddish Tools voice) when we have one. The first time a
// text is needed it has none yet, so Fonory's own Yiddish voice says it ({ say }), and the text is marked wanted;
// the background maker records it, and every call after hears the saved one.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { nowIso } from "../db.js";

export const CLIP_TRIES = 3;

// A play item for some text. base: our public address, for audio links.
export function piece(db, base, text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const row = db.prepare("SELECT * FROM clips WHERE text = ?").get(t);
  if (row?.status === "ready" && row.file) return { audio: `${base}/audio/clips/${row.file}` };
  if (!row) db.prepare("INSERT INTO clips (text, status, at) VALUES (?, 'wanted', ?)").run(t, nowIso());
  return { say: t };
}

// A person or place: an uploaded recording of the name first, then its Yiddish spelling, then its name.
export function namePiece(db, base, row) {
  if (!row) return null;
  if (row.recording) return { audio: `${base}/audio/${row.recording}` };
  return piece(db, base, row.spoken || row.name);
}

// Record what's wanted. speak(text) → a WAV Buffer. Returns how many were made.
export async function makeWanted(db, dir, speak, { limit = 20, log = console.warn } = {}) {
  const rows = db.prepare("SELECT * FROM clips WHERE status = 'wanted' AND tries < ? ORDER BY at LIMIT ?").all(CLIP_TRIES, limit);
  let made = 0;
  for (const r of rows) {
    try {
      const wav = await speak(r.text);
      fs.mkdirSync(path.join(dir, "clips"), { recursive: true });
      const file = `${crypto.randomBytes(10).toString("hex")}.wav`;
      fs.writeFileSync(path.join(dir, "clips", file), wav);
      db.prepare("UPDATE clips SET status = 'ready', file = ?, at = ? WHERE text = ?").run(file, nowIso(), r.text);
      made++;
    } catch (e) {
      const tries = r.tries + 1;
      db.prepare("UPDATE clips SET tries = ?, status = ?, at = ? WHERE text = ?").run(tries, tries >= CLIP_TRIES ? "failed" : "wanted", nowIso(), r.text);
      log(`recording "${r.text}" failed:`, e.message);
    }
  }
  return made;
}

// Ask for pieces ahead (the numbers and small words, and every name and place), so callers rarely hear Fonory's voice.
export function wantAll(db, texts) {
  const ins = db.prepare("INSERT OR IGNORE INTO clips (text, status, at) VALUES (?, 'wanted', ?)");
  for (const t of texts) if (String(t || "").trim()) ins.run(String(t).trim(), nowIso());
}
