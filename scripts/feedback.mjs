// Claude's side of the feedback box (docs/feedback-check.md). Uses the same key as the server (FEEDBACK_KEY, or the
// one made from GOOGLE_MAPS_API_KEY) and never prints it.
//   node scripts/feedback.mjs list [statuses]          new items by default, e.g. "new,needs_you"
//   node scripts/feedback.mjs set <id> <status> [reply]
// DISPATCH_URL defaults to the live server.
import { feedbackKey } from "../src/feedback.js";

const base = (process.env.DISPATCH_URL || "https://dirver-dispatch-production.up.railway.app").replace(/\/$/, "");
const key = feedbackKey(process.env);
if (!key) { console.error("No FEEDBACK_KEY or GOOGLE_MAPS_API_KEY in this environment."); process.exit(1); }
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const [cmd, ...args] = process.argv.slice(2);

let res;
if (cmd === "list" || !cmd) {
  res = await fetch(`${base}/api/feedback?status=${encodeURIComponent(args[0] || "new")}`, { headers });
} else if (cmd === "set" && args[0] && args[1]) {
  const body = { status: args[1] };
  if (args[2] != null) body.reply = args.slice(2).join(" ");
  res = await fetch(`${base}/api/feedback/${encodeURIComponent(args[0])}`, { method: "PATCH", headers, body: JSON.stringify(body) });
} else {
  console.error("Use: list [statuses] | set <id> <status> [reply]");
  process.exit(1);
}
const data = await res.json().catch(() => ({}));
console.log(JSON.stringify(data, null, 2));
if (!res.ok) process.exit(1);
