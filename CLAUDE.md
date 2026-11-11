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
- src/bookings.js: checking and saving ride requests (prepareRide, saveRides), propose time, status changes.
- src/travel.js: Google Geocoding and Routes API (computeRouteMatrix, traffic by hour), cached in geocodes and
  travel_times; straight-line estimate without a key (ROUTES_TRAFFIC=off drops traffic).
- src/route.js: the planner: timing a stop order, inserting a ride without making anyone later, rebuilding a day.
- src/dispatch.js: bookRide (with nearest times that fit), previewAccept, acceptRide, refreshDay, dayRoute. Only
  accepted and on-board rides are in the route (routes table); pending ones are checked against it.
- src/phone/ivr.js: the phone menu, one answer per Fonory step (POST /fonory/step), incoming and outgoing calls.
- src/phone/words.js: the prompt script P01-P47 (must match the doc's Recording script), Yiddish numbers, times, texts.
- src/phone/audio.js: spoken pieces (clips table): a saved recording, else Fonory's voice says it and we record it.
- src/phone/fonory.js: webhook key check and the outgoing call/text client (adapt to Teltech's docs when they come).
- src/phone/yiddishtools.js, scripts/make-recordings.mjs: the Yiddish Tools voice and the prompt files for Fonory.
- src/notify.js: messages to callers (booked, accepted, not taken, time change, reminder, late, cancelled), sent by
  Fonory, calls retried for reminders and time changes.
- src/db.js: schema and audit log.
- src/actions.js: what the driver or an admin does to a ride (accept, reject, propose, pickup, done, no-show, cancel)
  with the caller's messages; running late; late notices after a GPS refresh.
- src/driver.js: the driver app's API (/api/driver: phone + PIN sign-in, Bearer token, today, status, location,
  preview, actions with once-only keys, route order). web/driver/: the app page; android/: the APK wrapper (Java,
  WebView + TrackingService for GPS and request notifications), built by .github/workflows/android.yml.
- src/backup.js: the daily database copy. Dockerfile, railway.json, docs/going-live.md: hosting and the pilot.
- src/server.js: admin sign-in and API, serves the dashboard at /admin/ and the driver app at /driver/.
- src/auth.js: admin logins (scrypt passwords, hashed session tokens). First admin from ADMIN_EMAIL/ADMIN_PASSWORD.
- src/settings.js: hours, areas, trip limit stored in the database.
- src/reports.js, src/announcements.js: reports (wait, on time and ride length from the driver's marks; driving time
  and miles from GPS) and announcements (deliveries queued until the phone line is connected).
- src/feedback.js: comments, complaints, suggestions and requests from the dashboard and driver app; Claude reads
  and answers them at /api/feedback with FEEDBACK_KEY. docs/feedback-check.md: how the regular check works.
- web/: the admin dashboard (plain JS, one page).
