# Driver Dispatch

Phone-based ride booking and dispatch for a family ride service in Monsey and Spring Valley.
One central Fonory (Teltech) hotline, a booking engine that enforces seating rules and route timing,
an Android driver app, and an admin web dashboard.

## Running it

`npm install`, then `npm start` (port 3000, dashboard at /admin/). Environment variables:

- `ADMIN_EMAIL`, `ADMIN_PASSWORD`: the first admin, made on first start.
- `GOOGLE_MAPS_API_KEY`: needs the **Routes API** and the **Geocoding API** turned on. Without it, drive times are
  straight-line estimates and the route says so.
- `ROUTES_TRAFFIC=off`: plain drive times instead of live traffic (cheaper).
- `DB_FILE` (default `data/dispatch.db`), `RECORDINGS_DIR`, `PORT`.
- `PUBLIC_URL`: this server's https address, for the audio links Fonory plays.
- `FONORY_WEBHOOK_KEY`: the secret Fonory sends with every request (`X-Fonory-Key` header or `?key=`). Without it the
  phone line answers nothing.
- `FONORY_API_URL`, `FONORY_API_KEY`, `FONORY_FROM`: Fonory's API for outgoing calls and texts. Until they're set,
  messages wait in the queue.
- `YIDDISH_TOOLS_API_KEY`, `YT_VOICE` (default `pinchas`, or `custom:<id>` for a cloned voice), `YT_SPEED`: the
  Yiddish voice for recordings.

## The phone line

Fonory calls `POST /fonory/step` at every step of a call and `POST /fonory/status` when an outgoing call ends
(the contract is in the build plan's "Phone system setup" tab). The fixed prompts are made with
`node scripts/make-recordings.mjs` (one WAV per code in `recordings/prompts`, plus `script.txt`) and uploaded to
Fonory. Names, places, numbers and times are recorded by the server itself the first time they're needed and served
from `/audio/...`; until then Fonory's own Yiddish voice says them.

Map costs stay small: each address is looked up once, and each drive time between two points is fetched once per
hour of the day and kept 14 days.
