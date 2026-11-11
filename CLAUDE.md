# Driver Dispatch

Phone-based ride booking and dispatch for about 10 households (a family) in Monsey and Spring Valley.
One driver and one 7-seat vehicle for now; drivers and vehicles are separate tables so more can be added.
The full plan, spec decisions and the phone setup live in the project's build plan doc.

## Decisions
- Phone: Teltech Fonory hotline only (Shloime, 2026-11-10). Fonory plays pre-recorded Yiddish prompts and
  calls our server's API at each live step. Recordings are made with Getzel's Yiddish voice. Keypad only, no speech.
- Language: Yiddish only for now; households.language exists so English can be added later.
- Driver app: Android APK. Admin dashboard: English, web.
- Seating: front seat 1 man only; rows 2 and 3 hold 3 each, one gender per row, unless one booking marked
  "together" has the row to itself. Riders keep their seats from pickup to drop-off. See src/seating.js.
- Hours 10 AM to 6 PM America/New_York, same day only, 15 or 30 minute windows, max 30 minutes driving.

## Stack
- Node 22.13+ with ES modules, Express 5, SQLite through node:sqlite (data/dispatch.db, not in git).
- Tests: `npm test` (node:test). Keep every rule covered by a test.
- Keys never go in git or chat; they come from environment variables (ADMIN_EMAIL, ADMIN_PASSWORD, GOOGLE_MAPS_API_KEY, ...).

## Map
- src/seating.js: seat plans across a whole route, seats by stop.
- src/rules.js: hours, windows, keypad times, change cut-off.
- src/bookings.js: ride requests, accept, propose time, status changes, audit.
- src/db.js: schema and audit log.
- src/server.js: admin sign-in and API, serves the dashboard at /admin/.
- src/auth.js: admin logins (scrypt passwords, hashed session tokens). First admin from ADMIN_EMAIL/ADMIN_PASSWORD.
- src/settings.js: hours, areas, trip limit stored in the database.
- src/reports.js, src/announcements.js: reports and announcements (deliveries queued until the phone line is connected).
- web/: the admin dashboard (plain JS, one page).
