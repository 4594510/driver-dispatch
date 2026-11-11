// The Fonory (Teltech) connection.
//
// Incoming: Fonory calls POST /fonory/step at every live step and POST /fonory/status with how an outgoing call
// ended. A request is let in when it carries our secret, FONORY_WEBHOOK_KEY, as the X-Fonory-Key header or ?key=,
// or when it comes from one of Teltech's servers, FONORY_ALLOWED_IPS (comma-separated; 178.156.145.236 as of
// 2026-11-11). The address is req.ip: with "trust proxy" 1 that is the one Railway's edge saw, not one a caller wrote
// into X-Forwarded-For.
//
// Outgoing: we ask Fonory to place a call (it then runs our steps, starting with step "out:<delivery id>") or to send
// a text. Teltech's API documentation hasn't arrived yet, so the two requests below follow the contract in the phone
// setup doc and are the one place to adapt once it does: FONORY_API_URL, FONORY_API_KEY, FONORY_FROM (our line).
// Until those are set nothing goes out, and deliveries wait in the queue.
import crypto from "node:crypto";

// "::ffff:1.2.3.4" → "1.2.3.4"
const plainIp = (ip) => String(ip || "").trim().replace(/^::ffff:/i, "");

export function fromTeltech(req, env = process.env) {
  const allowed = String(env.FONORY_ALLOWED_IPS || "").split(",").map(plainIp).filter(Boolean);
  const ip = plainIp(req.ip);
  return Boolean(ip) && allowed.includes(ip);
}

export function webhookAllowed(req, env = process.env) {
  if (fromTeltech(req, env)) return true;
  const want = env.FONORY_WEBHOOK_KEY;
  if (!want) return false;
  const got = String(req.get("x-fonory-key") || req.query.key || "");
  const a = crypto.createHash("sha256").update(got).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

export function fonoryClient(env = process.env, fetchImpl = globalThis.fetch) {
  const url = env.FONORY_API_URL?.replace(/\/$/, "");
  const key = env.FONORY_API_KEY;
  if (!url || !key) return null;
  const post = async (path, body) => {
    const res = await fetchImpl(`${url}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Fonory ${path} ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
  };
  return {
    // Returns Fonory's call id.
    async call(to, step) {
      const data = await post("/calls", { to, from: env.FONORY_FROM, step });
      return data.call_id || data.id || null;
    },
    async text(to, body) {
      const data = await post("/messages", { to, from: env.FONORY_FROM, text: body });
      return data.message_id || data.id || null;
    },
  };
}
