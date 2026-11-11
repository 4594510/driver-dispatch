// Getzel's Yiddish voice, through Yiddish Tools (https://yiddish.tools/api/v1, Bearer YIDDISH_TOOLS_API_KEY):
// POST /speech/stream with format "wav" gives a whole WAV file. YT_VOICE picks the voice (a built-in id like
// "pinchas", or a cloned one as "custom:<id>"), YT_SPEED slow / normal / fast.
const BASE = "https://yiddish.tools/api/v1";

export function yiddishVoice(env = process.env, fetchImpl = globalThis.fetch) {
  const key = env.YIDDISH_TOOLS_API_KEY;
  if (!key) return null;
  const base = env.YIDDISH_TOOLS_URL || BASE;
  const voice = env.YT_VOICE || "pinchas";
  const speed = env.YT_SPEED || "normal";
  return async function speak(text) {
    const res = await fetchImpl(`${base}/speech/stream`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: String(text).slice(0, 2000), voice, format: "wav", speed }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`Yiddish Tools ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length <= 44) throw new Error("Yiddish Tools: no audio came back");
    return audio;
  };
}
