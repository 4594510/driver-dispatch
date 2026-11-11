// Feedback: comments, complaints, suggestions and requests from the admins (dashboard) and the driver (app).
// Each one is a row Claude reads and answers through /api/feedback, with the key in FEEDBACK_KEY:
//   GET   /api/feedback?status=new        the items to look at (newest last)
//   PATCH /api/feedback/:id {status,reply} what was done, shown back to whoever wrote it
// A scheduled Claude check reads the new ones, does what is asked (a pull request for code changes), and writes back.
import express from "express";
import crypto from "node:crypto";
import { newId, nowIso, audit } from "./db.js";

export const KINDS = ["comment", "complaint", "suggestion", "request"];
// new: not looked at yet | working: Claude is on it | needs_you: waiting on Shloime (the reply says what)
// | done | declined (the reply says why)
export const STATUSES = ["new", "working", "needs_you", "done", "declined"];
const MAX_TEXT = 4000;

export function addFeedback(db, { kind, text } = {}, source, author) {
  const t = String(text ?? "").trim();
  if (!t) return { ok: false, error: "Write something first." };
  if (t.length > MAX_TEXT) return { ok: false, error: `Keep it under ${MAX_TEXT} characters.` };
  const k = KINDS.includes(kind) ? kind : "comment";
  const id = newId("fb");
  const at = nowIso();
  db.prepare("INSERT INTO feedback (id, source, author, kind, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'new', ?, ?)")
    .run(id, source, author, k, t, at, at);
  audit(db, `${source}:${author}`, "feedback_added", null, { id, kind: k });
  return { ok: true, id };
}

export function listFeedback(db, { status, source, author, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push(`status IN (${String(status).split(",").map(() => "?").join(", ")})`); args.push(...String(status).split(",")); }
  if (source) { where.push("source = ?"); args.push(source); }
  if (author) { where.push("author = ?"); args.push(author); }
  const sql = `SELECT * FROM feedback ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
  return db.prepare(sql).all(...args, Math.min(Number(limit) || 200, 500));
}

export function updateFeedback(db, id, { status, reply } = {}, actor) {
  const f = db.prepare("SELECT * FROM feedback WHERE id = ?").get(id);
  if (!f) return { ok: false, error: "not_found" };
  if (status != null && !STATUSES.includes(status)) return { ok: false, error: `Status must be one of ${STATUSES.join(", ")}.` };
  const newReply = reply != null ? String(reply).trim().slice(0, MAX_TEXT) || null : f.reply;
  db.prepare("UPDATE feedback SET status = ?, reply = ?, updated_at = ? WHERE id = ?").run(status ?? f.status, newReply, nowIso(), id);
  audit(db, actor, "feedback_updated", null, { id, status: status ?? f.status });
  return { ok: true, feedback: db.prepare("SELECT * FROM feedback WHERE id = ?").get(id) };
}

// The key check for Claude's access. No FEEDBACK_KEY set: the endpoint is closed.
export function keyAllowed(req, env) {
  const want = env.FEEDBACK_KEY;
  const m = /^Bearer (.+)$/.exec(req.get("authorization") || "");
  if (!want || !m) return false;
  const a = crypto.createHash("sha256").update(m[1]).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

export function feedbackRouter(db, env) {
  const r = express.Router();
  r.use((req, res, next) => (keyAllowed(req, env) ? next() : res.status(403).json({ error: "forbidden" })));
  r.get("/", (req, res) => {
    // Oldest first, so items are handled in the order they came.
    const rows = listFeedback(db, { status: req.query.status, source: req.query.source, limit: req.query.limit }).reverse();
    res.json(rows);
  });
  r.patch("/:id", (req, res) => {
    const out = updateFeedback(db, req.params.id, req.body || {}, "claude");
    if (out.error === "not_found") return res.status(404).json(out);
    res.status(out.ok ? 200 : 400).json(out);
  });
  return r;
}
