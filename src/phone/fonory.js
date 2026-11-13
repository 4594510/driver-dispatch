// The Fonory (Teltech) connection.
//
// Incoming: Fonory calls POST /fonory/step at every live step and POST /fonory/status with how an outgoing call
// ended. Teltech gives the key (FONORY_WEBHOOK_KEY) and sends it as the X-Fonory-Key header (or ?key=); a request
// without exactly that value is refused. When FONORY_ALLOWED_IPS is set (comma-separated; Teltech's server is
// 178.156.145.236 as of 2026-11-11), the request must also come from one of those addresses. The address is req.ip:
// with "trust proxy" 1 that is the one Railway's edge saw, not one a caller wrote into X-Forwarded-For.
//
// Outgoing: we ask Fonory to place a call (it then runs our steps, starting with step "out:<delivery id>") or to send
// a text. Teltech's API documentation hasn't arrived yet, so the two requests below follow the contract in the phone
// setup doc and are the one place to adapt once it does: FONORY_API_URL, FONORY_API_KEY, FONORY_FROM (our line).
// Until those are set nothing goes out, and deliveries wait in the queue.
import crypto from "node:crypto";

// "::ffff:1.2.3.4" → "1.2.3.4"
const plainIp = (ip) => String(ip || "").trim().replace(/^::ffff:/i, "");

// True when no address list is set, or the request comes from one on it.
export function fromTeltech(req, env = process.env) {
  const allowed = String(env.FONORY_ALLOWED_IPS || "").split(",").map(plainIp).filter(Boolean);
  if (!allowed.length) return true;
  return allowed.includes(plainIp(req.ip));
}

export function webhookAllowed(req, env = process.env) {
  if (!fromTeltech(req, env)) return false;
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

// ---------- Teltech's Ride Line format ----------
// Their request: { event, call_id, caller_id: "18455550142", did, digits, variables, ... } with the step in the
// address (?step=menu); the first request of a call has no step (event "new_call"), and an answered outgoing call
// comes with event "outbound_answered" and the start name we gave ("out:<delivery id>"). A gather that got no key
// comes again with digits "". Older/our own shape ({ from, keys, step }) is still read.
export function readStep(req) {
  const b = req.body || {};
  const step = String(req.query.step || b.step || b.start || b.start_name || b.variables?.start || "") ||
    (b.event === "outbound_answered" ? "" : "start");
  return {
    call_id: b.call_id,
    from: b.caller_id ?? b.from,
    direction: b.event === "outbound_answered" || /^out:/.test(step) ? "outbound" : b.direction || "inbound",
    step: step || "start",
    keys: b.digits ?? b.keys ?? "",
    // A spoken answer (their "collect" with transcribe): what the caller said, as text.
    ...(b.event === "collect" || b.field_transcript != null || b.transcript != null ? { transcript: transcriptOf(b) } : {}),
    event: b.event,
  };
}
// The words of a spoken answer: field_transcript by their guide; also the call variable <id>_text, and a field_value
// that is text and not a recording path, in case the box sends it there.
function transcriptOf(b) {
  const id = b.field_id || "address";
  const value = typeof b.field_value === "string" && !/\.(wav|mp3)$/i.test(b.field_value) ? b.field_value : null;
  const t = b.field_transcript ?? b.transcript ?? b[`${id}_text`] ?? b.variables?.[`${id}_text`] ?? b.collected?.[`${id}_text`] ?? value ?? "";
  return String(t);
}

// One line per phone step in the server log, to see what a call did (the caller by the last 4 digits only).
export function stepLine(s, res) {
  const said = s.transcript != null ? ` heard="${String(s.transcript).slice(0, 80)}"` : "";
  const next = res?.listen ? `listen:${res.listen.step}` : res?.gather ? `ask:${res.gather.step}` : "end";
  const prompts = (res?.play || []).filter((p) => p.prompt).map((p) => p.prompt).join(",");
  return `phone ${String(s.call_id || "").slice(-6)} ..${String(s.from || "").slice(-4)} ${s.event || ""} step=${s.step} keys="${s.keys}"${said} -> ${next} [${prompts}]`;
}

// Our answer ({ play, gather, hangup }) as their { actions }. Fixed prompts are played from our own server
// (/prompts/P19.wav, the recordings at 8 kHz), unless FONORY_PROMPTS=uploaded says they are in the box by name.
export function toActions(res, base, env = process.env) {
  const uploaded = env.FONORY_PROMPTS === "uploaded";
  const actions = [];
  for (const p of res.play || []) {
    if (p.prompt) actions.push({ action: "play", file: uploaded ? `${p.prompt}.wav` : `${base}/prompts/${p.prompt}.wav` });
    else if (p.audio) actions.push({ action: "play", file: p.audio });
    else if (p.say) actions.push({ action: "say", text: String(p.say).slice(0, 500), language: p.language || "yiddish" });
  }
  // A spoken answer (a one-time address): their "collect" of the caller's voice, turned into text.
  if (res.listen && !res.hangup) {
    // Barge-in (Teltech IVR-945, live 2026-11-12): the caller may start speaking while the collect's own prompt
    // plays, so the last piece played before listening becomes that prompt.
    const prompt = actions.length ? actions.pop() : undefined;
    actions.push({
      ...(prompt ? { prompt } : {}),
      // Street names are English even when the caller speaks Yiddish; FONORY_TRANSCRIBE_LANGUAGE=auto lets Teltech guess.
      // beep: false (Teltech, 2026-11-12): no tone, the caller speaks right after our prompt; silence ends it.
      action: "collect", type: "voice", id: "address", transcribe: true, beep: false,
      ...((env.FONORY_TRANSCRIBE_LANGUAGE || "en") !== "auto" ? { transcribe_language: env.FONORY_TRANSCRIBE_LANGUAGE || "en" } : {}),
      max_duration: res.listen.max_s || 20, silence_timeout: 3, timeout: 10000,
      action_url: `${base}/fonory/step?step=${encodeURIComponent(res.listen.step)}`,
    });
    return { actions };
  }
  if (res.gather && !res.hangup) {
    const g = res.gather;
    actions.push({
      action: "gather",
      max_digits: g.max_keys || 1,
      timeout: (g.timeout_s || 6) * 1000,
      tries: 1,
      // Several keys: they are sent 2.5 seconds after the last key (no # needed), or at once with #.
      ...(g.max_keys > 1 ? { terminator: "#", digit_timeout: 2500 } : {}),
      // # alone is an answer of its own (from / to: say an address), not "no input".
      ...(g.min_keys === 0 ? { min_digits: 0 } : {}),
      action_url: `${base}/fonory/step?step=${encodeURIComponent(g.step)}`,
    });
  } else actions.push({ action: "hangup" });
  return { actions };
}
