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

Map costs stay small: each address is looked up once, and each drive time between two points is fetched once per
hour of the day and kept 14 days.
