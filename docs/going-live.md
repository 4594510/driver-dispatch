# Going live

Everything here is a step for a person (accounts, phones, money). The code is ready for each of them.

## 1. Put the server online (Railway)

1. On railway.com, New Project → Deploy from GitHub repo → this repository. It builds from the `Dockerfile`.
2. Add a **volume** mounted at `/app/data` (the database, recordings and daily backups live there).
3. Variables: `ADMIN_EMAIL`, `ADMIN_PASSWORD` (the first admin; change the password after signing in),
   `GOOGLE_MAPS_API_KEY`, `YIDDISH_TOOLS_API_KEY`, `YT_VOICE=shloimy`, `PUBLIC_URL` (the https address Railway gives,
   or your own domain), `FONORY_WEBHOOK_KEY` (any long random text; the same text goes into Fonory).
4. Open `<PUBLIC_URL>/admin/`, sign in, add the families, passengers, phones, places (with their Yiddish names) and the
   driver. Set the driver's PIN under Settings → Drivers.

About $5 to $10 a month for this size.

## 2. The phone line (Fonory)

The line is 845-731-5290 (`FONORY_FROM=+18457315290`). Teltech's calls come from 178.156.145.236
(`FONORY_ALLOWED_IPS`, comma-separated if they add more). Teltech gives the webhook key: it goes in Railway as
`FONORY_WEBHOOK_KEY`, and they send it as the `X-Fonory-Key` header. A request needs that exact key and one of
those addresses.

Teltech's format: https://ivr.teltech.info/developers/api-box/ride-line/ (src/phone/fonory.js translates it).

1. The prompts are played from our server (`prompts/`, 8 kHz copies of the recordings in the project files; re-copy
   them with ffmpeg `-ar 8000 -ac 1` after re-recording). Only P03 must be uploaded to the Fonory box, because callers
   hear it when our server can't answer. If all of them are uploaded there, set `FONORY_PROMPTS=uploaded`.
2. Point Fonory's step webhook at `<PUBLIC_URL>/fonory/step` and the call-status webhook at `<PUBLIC_URL>/fonory/status`.
   A refused request is logged as "phone line: refused … from <address>".
3. When Teltech sends their API documentation: set `FONORY_API_URL`, `FONORY_API_KEY`, and adapt
   `src/phone/fonory.js` if their requests differ. Until then calls in work, and outgoing texts and calls wait in the queue.

## 3. The driver's phone

1. In GitHub → Settings → Secrets and variables → Actions → Variables, add `DRIVER_SERVER_URL` = the `PUBLIC_URL`, then
   run the "Driver app" action (Actions tab → Driver app → Run workflow). Without it the app asks for the address
   when it first opens.
2. Optional but better: a signing key, so a new version installs over the old one without uninstalling. Make one
   (`keytool -genkeypair -keystore driver.jks -alias driver -keyalg RSA -validity 10000`), then add the secrets
   `DRIVER_KEYSTORE_B64` (the file in base64) and `DRIVER_KEYSTORE_PASSWORD`. Keep a copy of the file.
3. On the driver's Android phone, open the repository's Releases page → "driver-app" → `driver-app.apk`, allow
   installing from the browser, install. Sign in with the driver's phone number and PIN. Allow location ("While using
   the app" is enough: the app keeps a notification on while it shares location) and notifications.
4. The app also works in any phone browser at `<PUBLIC_URL>/driver/` (GPS only while the page is open).

## 4. Test with test phones (2 to 3 days)

Use 2 or 3 phones added as a test family. Go through each, and note anything that sounds or looks wrong:

- Call in from an unknown number: hears "not registered".
- Book for yourself and for someone else; from home and from a place code; now and later; the 15 minute window (not asked any more);
  with a return trip.
- Book when the van would be full at that time: hears the next time that fits, presses 1 to take it.
- Driver offline: the caller hears the ride waits unconfirmed. Driver online: "sent to the driver", the phone rings
  in the app.
- Driver: preview, accept (caller gets "confirmed"), reject (caller gets "not taken"), suggest a time (caller is called
  and presses 1 or 2).
- Check rides by phone (menu 2), change the pickup place and cancel (menu 3); cancel inside the last half hour is refused.
- Reminder call before arrival; let it ring out once to see the 2 retries.
- Driver: picked up, dropped off, no-show; running late (riders past their window get the new time); change the order
  of stops; turn off the phone's data for a few stops and back on (actions and GPS are sent afterwards).
- Admin: an announcement by text and by voice; the day's report (wait, on time, driving time, miles).

## 5. Pilot week with the family

Run it for real for a week with the driver and the families, with the driver's cell as the backup. Each evening look
at Today, the Activity log and the Reports; after the week, decide what to change before calling it launched.
