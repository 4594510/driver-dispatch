// The database: one SQLite file. Drivers and vehicles are their own tables from the start, so a second driver or
// vehicle later is new rows, not a rebuild (spec section 16).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export function openDb(file = process.env.DB_FILE || "data/dispatch.db") {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL                        -- JSON
    );

    CREATE TABLE IF NOT EXISTS households (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'yi',       -- phone menu language; only 'yi' for now
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    -- People who ride. A booking can be made for anyone in the caller's household, or for another person.
    CREATE TABLE IF NOT EXISTS passengers (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      name TEXT NOT NULL,
      gender TEXT NOT NULL CHECK (gender IN ('m', 'f')),
      recording TEXT,                            -- file name of the recorded name, for the phone menu
      notes TEXT NOT NULL DEFAULT '',            -- instructions the driver sees
      active INTEGER NOT NULL DEFAULT 1
    );

    -- Approved phone numbers. Only these can book or check rides.
    CREATE TABLE IF NOT EXISTS phones (
      number TEXT PRIMARY KEY,                   -- E.164, +18455551234
      household_id TEXT NOT NULL REFERENCES households(id),
      passenger_id TEXT REFERENCES passengers(id),
      notify TEXT NOT NULL DEFAULT 'both' CHECK (notify IN ('text', 'voice', 'both')),
      active INTEGER NOT NULL DEFAULT 1
    );

    -- Saved places, picked on the phone by a 2-digit code. household_id NULL = shared by everyone (a shul, a store).
    CREATE TABLE IF NOT EXISTS places (
      id TEXT PRIMARY KEY,
      household_id TEXT REFERENCES households(id),
      code TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'other',        -- home | work | other
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      lat REAL,
      lng REAL,
      recording TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS drivers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'offline',    -- online | offline | paused
      paused_until TEXT,
      last_lat REAL,
      last_lng REAL,
      last_seen_at TEXT
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      layout TEXT NOT NULL,                      -- JSON seat layout, see seating.js
      driver_id TEXT REFERENCES drivers(id)
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      day TEXT NOT NULL,                         -- local date, 2026-11-11
      household_id TEXT NOT NULL REFERENCES households(id),
      booked_by_phone TEXT NOT NULL,
      passenger_id TEXT REFERENCES passengers(id),
      rider_name TEXT NOT NULL,
      men INTEGER NOT NULL,
      women INTEGER NOT NULL,
      together INTEGER NOT NULL DEFAULT 0,       -- men and women may share a row
      pickup_place_id TEXT REFERENCES places(id),
      pickup_address TEXT NOT NULL,
      dropoff_place_id TEXT REFERENCES places(id),
      dropoff_address TEXT NOT NULL,
      pickup_minute INTEGER NOT NULL,            -- start of the pickup window, minutes after midnight
      window_minutes INTEGER NOT NULL,           -- 15 or 30
      return_of TEXT REFERENCES bookings(id),    -- set on a return trip
      status TEXT NOT NULL DEFAULT 'pending',
        -- pending (waiting for the driver) | accepted | rejected | proposed (driver suggested a time)
        -- | cancelled | picked_up | completed | no_show
      proposed_minute INTEGER,
      driver_id TEXT REFERENCES drivers(id),
      vehicle_id TEXT REFERENCES vehicles(id),
      seats TEXT,                                -- JSON seat plan for this booking
      eta_minute INTEGER,
      confirmed_by_passenger INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bookings_day ON bookings (day, status);

    -- Every change to a booking and every driver action (spec section 16).
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,                       -- admin:<email> | driver:<id> | phone:<number> | system
      action TEXT NOT NULL,
      booking_id TEXT,
      details TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS admins (
      email TEXT PRIMARY KEY,
      password_hash TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      recording TEXT,
      audience TEXT NOT NULL DEFAULT 'all',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      announcement_id TEXT REFERENCES announcements(id),
      booking_id TEXT REFERENCES bookings(id),
      phone TEXT NOT NULL,
      channel TEXT NOT NULL,                     -- text | voice
      kind TEXT NOT NULL,                        -- announcement | confirmation | reminder | time_change | ...
      status TEXT NOT NULL DEFAULT 'queued',     -- queued | sent | answered | no_answer | failed
      attempts INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    -- Route planning (stage 3). Addresses turned into map points, travel times between points by hour of the day
    -- (bucket -1 when traffic is off), and each day's stop order per vehicle.
    CREATE TABLE IF NOT EXISTS geocodes (
      address TEXT PRIMARY KEY,                  -- lower-cased, trimmed
      lat REAL,
      lng REAL,                                  -- both NULL: Google found nothing (kept so we don't ask again)
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS travel_times (
      a TEXT NOT NULL,                           -- "lat,lng" to 5 decimals
      b TEXT NOT NULL,
      bucket INTEGER NOT NULL,                   -- hour of the day the leg starts, or -1 without traffic
      minutes REAL NOT NULL,
      meters INTEGER,
      at TEXT NOT NULL,
      PRIMARY KEY (a, b, bucket)
    );
    CREATE TABLE IF NOT EXISTS routes (
      day TEXT NOT NULL,
      vehicle_id TEXT NOT NULL,                  -- 'main' while there are no vehicles in the table
      stops TEXT NOT NULL,                       -- JSON [{ booking_id, kind: pickup|dropoff, arrive, depart }]
      drive_minutes REAL,
      estimated INTEGER NOT NULL DEFAULT 0,      -- some legs were guessed from straight-line distance
      updated_at TEXT NOT NULL,
      PRIMARY KEY (day, vehicle_id)
    );

    -- The phone line (stage 4). One row per call Fonory tells us about, with where the caller is in the menu.
    CREATE TABLE IF NOT EXISTS phone_calls (
      call_id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      direction TEXT NOT NULL,                   -- inbound | outbound
      delivery_id INTEGER,                       -- an outgoing call: the message it carries
      state TEXT NOT NULL DEFAULT '{}',          -- JSON: step, tries, the ride being ordered
      result TEXT,                               -- answered | no_answer | busy | failed | completed
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- Spoken pieces (words, numbers, names, places) made with the Yiddish voice, by their exact text.
    CREATE TABLE IF NOT EXISTS clips (
      text TEXT PRIMARY KEY,
      file TEXT,                                 -- in RECORDINGS_DIR/clips
      status TEXT NOT NULL DEFAULT 'wanted',     -- wanted | ready | failed
      tries INTEGER NOT NULL DEFAULT 0,
      at TEXT NOT NULL
    );
  `);
  addColumns(db, "passengers", { spoken: "TEXT" }); // the name in Yiddish letters, as the phone says it
  addColumns(db, "places", { spoken: "TEXT" });
  addColumns(db, "deliveries", {
    due_at: "TEXT",                              // not before this time
    payload: "TEXT",                             // JSON: what the message says (times, names)
    body: "TEXT",                                // a text message's words
    call_id: "TEXT",
    note: "TEXT",                                // why it failed, or the key pressed
  });
  addColumns(db, "bookings", {
    pickup_lat: "REAL",
    pickup_lng: "REAL",
    dropoff_lat: "REAL",
    dropoff_lng: "REAL",
    picked_up_minute: "INTEGER", // when the driver marked the pickup, minutes after midnight
    eta_dropoff_minute: "INTEGER",
    dropped_off_minute: "INTEGER", // when the driver marked the drop-off
  });
  // The driver app (stage 5).
  addColumns(db, "drivers", { pin_hash: "TEXT" }); // the app's sign-in: the driver's phone and a PIN set by an admin
  addColumns(db, "routes", { manual: "INTEGER NOT NULL DEFAULT 0" }); // the driver set the order by hand: keep it
  db.exec(`
    CREATE TABLE IF NOT EXISTS driver_sessions (
      token_hash TEXT PRIMARY KEY,
      driver_id TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    -- GPS points from the app, for live position, arrival times and the driving reports.
    CREATE TABLE IF NOT EXISTS driver_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_id TEXT NOT NULL,
      at TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      accuracy REAL,
      speed REAL
    );
    CREATE INDEX IF NOT EXISTS driver_locations_at ON driver_locations (driver_id, at);
    -- Actions the app sent with its own key, so one made without signal and sent twice is done once.
    CREATE TABLE IF NOT EXISTS driver_actions (
      key TEXT PRIMARY KEY,
      driver_id TEXT NOT NULL,
      at TEXT NOT NULL,
      result TEXT NOT NULL
    );
    -- Priority levels an admin sets for a family (passenger_id NULL) or one person, always or between two local
    -- times ("2026-11-12T10:00"; NULL = no start or no end). See priority.js.
    CREATE TABLE IF NOT EXISTS priorities (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id),
      passenger_id TEXT REFERENCES passengers(id),
      level INTEGER NOT NULL,                    -- 1 High, 2 Top (0 Normal is no rule)
      starts_at TEXT,
      ends_at TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
  `);
  return db;
}

// Columns added after a table was first made: add them to an existing database file.
function addColumns(db, table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, type] of Object.entries(cols)) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
export const nowIso = () => new Date().toISOString();

export function audit(db, actor, action, bookingId = null, details = {}) {
  db.prepare("INSERT INTO audit (at, actor, action, booking_id, details) VALUES (?, ?, ?, ?, ?)").run(
    nowIso(),
    actor,
    action,
    bookingId,
    JSON.stringify(details),
  );
}
