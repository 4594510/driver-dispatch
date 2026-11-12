# Driver Dispatch

Phone-based ride booking and dispatch for about 10 households (a family) in Monsey and Spring Valley.
One driver and one 7-seat vehicle for now; drivers and vehicles are separate tables so more can be added.
The full plan, spec decisions and the phone setup live in the project's build plan doc.

## Decisions
- Phone: Teltech Fonory hotline only (Shloime, 2026-11-10). Fonory plays pre-recorded Yiddish prompts and
  calls our server's API at each live step. Recordings are made with Getzel's Yiddish voice. Keypad only, except saying a one-time address.
- Language: Yiddish only for now; households.language exists so English can be added later.
- Driver app: Android APK. Admin dashboard: English, web.
- Seating: front seat 1 man only; rows 2 and 3 hold 3 each, one gender per row, unless one booking marked
  "together" has the row to itself. Riders keep their seats from pickup to drop-off. See src/seating.js.
  When only the seat rules don't fit, the request still goes to the driver; the app tells him and he may take it
  anyway (bookings.seat_override): while it is on the route, seats are only counted (never over 7), no row plan.
- Relations (dashboard, Families tab): two people's relation plus a seat rule: "may sit next to each other" (that man
  and woman may share a row, even on separate rides) or "must not sit next to each other" (never one row). The phone
  no longer names who is coming (2026-11-12): rules apply to the riders named on a ride (dashboard, or the caller).
- Hours 10 AM to 6 PM America/New_York, same day only, 15 or 30 minute windows (the phone no longer asks: always 15,
  P17 unused), max 30 minutes driving. The "#" tip (P67) is not said any more.
- Phone booking is the short way (Shloime, 2026-11-12: "quick, easy, simple"): for myself or more people (P06; more
  people = how many men, how many women in all, P08/P09, no "together" question: seats are just counted, one gender per
  row), from, to, when, read-back. "For myself" on a family's phone picks the name (P07). A ride back and someone else
  are under "more options" (2 at the read-back, P69). The main menu stays as it was (Shloime, 2026-11-12). P10, P18,
  P60-P64 and P68 unused.
  From and to (P11/P12): type the place code and #, 0 home, # alone (or no key) says an address, * the list (Shloime,
  2026-11-12). The "#" tip (P67) is no longer said.
- Driver app is kept very simple (the driver is not technical): Now / Today / More, one Start/Stop work button, new
  rides on the Now screen with "Take it" / "Can't", one big button per stop.

## Stack
- Node 22.13+ with ES modules, Express 5, SQLite through node:sqlite (data/dispatch.db, not in git).
- Tests: `npm test` (node:test). Keep every rule covered by a test.
- Keys never go in git or chat; they come from environment variables (ADMIN_EMAIL, ADMIN_PASSWORD, GOOGLE_MAPS_API_KEY, ...).

## Map
- src/seating.js: seat plans across a whole route, seats by stop.
- src/rules.js: hours, windows, keypad times, change cut-off.
- src/bookings.js: checking and saving ride requests (prepareRide, saveRides), propose time, status changes.
- src/travel.js: Google Geocoding (lookup checks a new address: near Monsey, more than a town) and Routes API (computeRouteMatrix, traffic by hour), cached in geocodes and
  travel_times; straight-line estimate without a key (ROUTES_TRAFFIC=off drops traffic).
- src/route.js: the planner: timing a stop order, inserting a ride without making anyone later, rebuilding a day.
- src/dispatch.js: bookRide (with nearest times that fit), previewAccept, acceptRide, refreshDay, dayRoute. Only
  accepted and on-board rides are in the route (routes table); pending ones are checked against it.
- src/phone/ivr.js: the phone menu, one answer per Fonory step (POST /fonory/step), incoming and outgoing calls.
  "#" alone at "from"/"to" (or code 100) is a one-time address: the caller says it (Teltech's voice collect with transcribe, the only
  spoken step; also code 100), travel.lookup finds it, it is read back in English (P56-P59), then kept for everyone
  or for this ride only (P65-P66). Menu key 6 just adds an address. "#" skips a question with the usual answer (SKIP, P67).
- src/places.js: saved addresses, usable by everyone (codes 1-6 digits, default the house number, 100 reserved). Two
  places may share a code: a caller's own family's place wins, else the caller hears the names and picks (codeMatches,
  <which>_choose); only one family can't repeat its own code. src/seed.js: place lists Shloime gave, added once at startup.
- src/phone/words.js: the prompt script P01-P69 (must match the doc's Recording script), Yiddish numbers, times, texts.
- src/phone/audio.js: spoken pieces (clips table): a saved recording, else Fonory's voice says it and we record it.
- src/phone/fonory.js: webhook check (Teltech's X-Fonory-Key + their IP), Teltech's Ride Line request/answer format
  (readStep, toActions; https://ivr.teltech.info/developers/api-box/ride-line/), the outgoing call/text client
  (planned on their side, field names not final). prompts/: P01-P69 at 8 kHz, served at /prompts/ for Fonory to play.
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
- src/server.js: admin sign-in and API, serves the dashboard at /admin/ and the driver app at /driver/. A phone
  belongs to a whole family or to one person in it (phones.passenger_id); a person's own phone books that person without asking.
- src/auth.js: admin logins (scrypt passwords, hashed session tokens). First admin from ADMIN_EMAIL/ADMIN_PASSWORD.
- src/relations.js: relations and seat rules between people (relations table), the riders named on a ride
  (bookings.riders), and who a phone may name (its family and their relatives). Rules reach seating.js on each ride's
  people.
- src/settings.js: hours, areas, trip limit stored in the database. getSettings(db, now) puts today's schedule in.
- src/schedule.js: schedule changes (other hours or no rides for a day or range, optionally some weekdays; newest
  wins), set by the driver app (More, My hours) and the dashboard (Schedule tab); callers hear them (menu key 4, P48-P53).
- src/priority.js: priority levels (Normal, High, Top) an admin sets for a family or one person, always or for a
  local time range. Used by dispatch.js: the driver's requests are sorted by it, the accept preview warns when a ride
  would leave no room for a waiting higher-priority one, and the planner weighs higher-priority waiting more. It never
  moves an accepted ride later.
- src/reports.js, src/announcements.js: reports (wait, on time and ride length from the driver's marks; driving time
  and miles from GPS) and announcements (deliveries queued until the phone line is connected; callers hear the last two
  weeks of them again with menu key 5, P54-P55).
- src/feedback.js: comments, complaints, suggestions and requests from the dashboard and driver app; Claude reads
  and answers them at /api/feedback (scripts/feedback.mjs). docs/feedback-check.md: how the regular check works.
- web/: the admin dashboard (plain JS, one page): sections in a left sidebar (a top bar on phones), Overview first.
