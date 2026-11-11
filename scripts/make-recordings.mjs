// Make the fixed prompts (P01 to P47) with the Yiddish Tools voice, one WAV per code, to upload to Fonory.
//   YIDDISH_TOOLS_API_KEY=... node scripts/make-recordings.mjs [--out recordings/prompts] [--only P01,P27b] [--force]
// YT_VOICE picks the voice (default pinchas; a cloned voice is custom:<id>), YT_SPEED slow / normal / fast.
// Existing files are kept unless --force, so a changed line is remade with --only <code> --force.
import fs from "node:fs";
import path from "node:path";
import { PROMPTS } from "../src/phone/words.js";
import { yiddishVoice } from "../src/phone/yiddishtools.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const out = arg("out", "recordings/prompts");
const only = arg("only", "").split(",").filter(Boolean);
const force = process.argv.includes("--force");
const speak = yiddishVoice();
if (!speak) {
  console.error("Set YIDDISH_TOOLS_API_KEY first.");
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
const lines = [];
for (const [code, text] of Object.entries(PROMPTS)) {
  if (only.length && !only.includes(code)) continue;
  const file = path.join(out, `${code}.wav`);
  lines.push(`${code}\t${text}`);
  if (fs.existsSync(file) && !force) continue;
  try {
    fs.writeFileSync(file, await speak(text));
    console.log(`${code} made`);
  } catch (e) {
    console.error(`${code} failed: ${e.message}`);
    process.exitCode = 1;
  }
}
fs.writeFileSync(path.join(out, "script.txt"), lines.join("\n") + "\n");
console.log(`Done. Files are in ${out}; script.txt lists what each one says.`);
