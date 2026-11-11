// Admin logins: email and password (scrypt), a session cookie, more admins added by an admin.
// The first admin comes from ADMIN_EMAIL and ADMIN_PASSWORD when the admins table is empty; they should change the
// password after the first sign-in. Sessions last 30 days and are stored hashed, so a database copy holds no live login.
import crypto from "node:crypto";
import { nowIso, audit } from "./db.js";

const COOKIE = "dd_session";
const SESSION_DAYS = 30;
const MIN_PASSWORD = 10;

export function initAuth(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );`);
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function checkPassword(password, stored) {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const [, salt, hash] = stored.split("$");
  const got = crypto.scryptSync(password, Buffer.from(salt, "hex"), 32);
  const want = Buffer.from(hash, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export const normEmail = (e) => String(e || "").trim().toLowerCase();

export function passwordProblem(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  return null;
}

export function addAdmin(db, email, password, by) {
  const e = normEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { ok: false, error: "That email address doesn't look right." };
  const bad = passwordProblem(password);
  if (bad) return { ok: false, error: bad };
  if (db.prepare("SELECT 1 FROM admins WHERE email = ?").get(e)) return { ok: false, error: "That admin already exists." };
  db.prepare("INSERT INTO admins (email, password_hash, created_at) VALUES (?, ?, ?)").run(e, hashPassword(password), nowIso());
  audit(db, by, "admin_added", null, { email: e });
  return { ok: true, email: e };
}

export function ensureFirstAdmin(db, env) {
  const count = db.prepare("SELECT count(*) n FROM admins").get().n;
  if (count === 0 && env.ADMIN_EMAIL && env.ADMIN_PASSWORD) addAdmin(db, env.ADMIN_EMAIL, env.ADMIN_PASSWORD, "system");
}

export function startSession(db, email) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare("INSERT INTO sessions (token_hash, email, expires_at) VALUES (?, ?, ?)").run(sha(token), email, expires);
  return { token, expires };
}

function readCookie(req) {
  const raw = req.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

export function sessionEmail(db, req) {
  const token = readCookie(req);
  if (!token) return null;
  const row = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(sha(token));
  if (!row || row.expires_at < nowIso()) return null;
  if (!db.prepare("SELECT 1 FROM admins WHERE email = ?").get(row.email)) return null;
  return row.email;
}

export function setCookie(res, req, token, expires) {
  const secure = req.secure || req.get("x-forwarded-proto") === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expires).toUTCString()}${secure}`);
}

export function clearCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

export function endSession(db, req) {
  const token = readCookie(req);
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
}

// Slow down password guessing: at most 10 failed tries per address and email in 15 minutes.
const fails = new Map();
export function tooManyTries(key) {
  const now = Date.now();
  const list = (fails.get(key) || []).filter((t) => now - t < 15 * 60e3);
  fails.set(key, list);
  return list.length >= 10;
}
export function noteFailure(key) {
  fails.set(key, [...(fails.get(key) || []), Date.now()]);
}
