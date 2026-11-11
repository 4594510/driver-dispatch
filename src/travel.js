// Travel times and map points (stage 3).
//
// Google Maps Platform does the real work: the Geocoding API turns an address into a point, and the Routes API
// (computeRouteMatrix) gives driving times, with live traffic for the hour the leg starts. Both are cached in the
// database, so a family's usual places are paid for once (travel times are kept TRAVEL_KEEP_DAYS, then fetched again).
// Without a key, or when Google fails, a leg is estimated from the straight-line distance and the route says so.
import { localParts } from "./rules.js";

export const TRAVEL_KEEP_DAYS = 14;
const MATRIX_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
// Prefer matches around Monsey and Spring Valley, so "12 Main St" finds the local street first.
const AREA_BOUNDS = "41.05,-74.20|41.20,-73.95";
const AREA_CENTER = { lat: 41.11, lng: -74.07 }; // Monsey
export const AREA_KM = 40;
// Google answers that name only an area, not a street or a building.
const VAGUE_TYPES = ["political", "country", "administrative_area_level_1", "administrative_area_level_2", "administrative_area_level_3",
  "locality", "sublocality", "neighborhood", "postal_code", "colloquial_area"];

// Number words as said on the phone ("twelve Main Street", "twenty five", "one hundred three") → digits.
const ONES = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
export function spokenNumbers(text) {
  const words = String(text).split(/(\s+|-)/);
  const out = [];
  let n = null;
  const flush = () => { if (n != null) out.push(String(n)); n = null; };
  for (const raw of words) {
    const w = raw.toLowerCase();
    if (/^(\s+|-)$/.test(raw)) { if (n == null) out.push(raw); continue; }
    if (w in ONES) n = n != null && n % 10 === 0 && n >= 20 && ONES[w] < 10 ? n + ONES[w] : n != null && n < 10 && n > 0 ? n * 10 + ONES[w] : (flush(), ONES[w]);
    else if (w in TENS) n = n != null && n > 0 && n < 100 ? n * 100 + TENS[w] : (flush(), TENS[w]);
    else if (w === "hundred" && n != null) n *= 100;
    else { if (n != null) { flush(); out.push(" "); } out.push(raw); }
  }
  flush();
  return out.join("").replace(/\s+/g, " ").trim();
}
const MAX_SIDE = 25; // 25 x 25 = 625 elements, Google's limit per traffic-aware request
const UNKNOWN_LEG_MINUTES = 15; // a leg to or from an address with no point at all

export function pointKey(lat, lng) {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}
const parseKey = (k) => k.split(",").map(Number);

// Straight-line estimate: road distance about 1.35 times the straight line, 40 km/h average in town, plus 2 minutes.
export function estimateMinutes(a, b) {
  if (a && b && a === b) return 0;
  if (!a || !b) return UNKNOWN_LEG_MINUTES;
  const [la1, ln1] = parseKey(a);
  const [la2, ln2] = parseKey(b);
  const rad = Math.PI / 180;
  const h = Math.sin(((la2 - la1) * rad) / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(((ln2 - ln1) * rad) / 2) ** 2;
  const km = 2 * 6371 * Math.asin(Math.sqrt(h));
  return Math.round(((km * 1.35) / 40) * 60 + 2);
}

// The moment (UTC) of a local day + minute in a time zone.
export function zonedInstant(day, minute, timeZone) {
  const [y, m, d] = day.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d, 0, minute);
  let t = target;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(t), timeZone);
    const [py, pm, pd] = p.day.split("-").map(Number);
    t += target - Date.UTC(py, pm - 1, pd, 0, p.minute);
  }
  return new Date(t);
}

// Google wants a departure time in the future. For an hour bucket, the next weekday (Monday to Friday) at that hour
// and half past.
export function departureFor(bucket, now, timeZone) {
  const today = localParts(now, timeZone).day;
  for (let k = 0; k < 8; k++) {
    const base = new Date(`${today}T12:00:00Z`);
    base.setUTCDate(base.getUTCDate() + k);
    const day = base.toISOString().slice(0, 10);
    const wd = base.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const at = zonedInstant(day, bucket * 60 + 30, timeZone);
    if (at.getTime() > now.getTime() + 5 * 60000) return at;
  }
  return new Date(now.getTime() + 3600000);
}

export function createTravel(db, opts = {}) {
  const apiKey = opts.apiKey || null;
  const fetchImpl = opts.fetch || globalThis.fetch;
  const traffic = opts.traffic !== false;
  const now = opts.now || (() => new Date());
  const timeZone = opts.timeZone || "America/New_York";
  const log = opts.log || ((...a) => console.warn(...a));
  const bucketOf = (minute) => (traffic ? Math.max(0, Math.min(23, Math.floor(minute / 60))) : -1);
  const stats = { matrixRequests: 0, elements: 0, geocodes: 0, failures: 0 };

  const getTime = db.prepare("SELECT minutes, at FROM travel_times WHERE a = ? AND b = ? AND bucket = ?");
  const anyTime = db.prepare("SELECT minutes, bucket FROM travel_times WHERE a = ? AND b = ? ORDER BY abs(bucket - ?) LIMIT 1");
  const putTime = db.prepare(`INSERT INTO travel_times (a, b, bucket, minutes, meters, at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(a, b, bucket) DO UPDATE SET minutes = excluded.minutes, meters = excluded.meters, at = excluded.at`);
  const fresh = (row) => row && now().getTime() - new Date(row.at).getTime() < TRAVEL_KEEP_DAYS * 86400000;

  async function geocode(address) {
    const norm = String(address || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!norm) return null;
    const row = db.prepare("SELECT lat, lng FROM geocodes WHERE address = ?").get(norm);
    if (row) return row.lat == null ? null : { lat: row.lat, lng: row.lng };
    if (!apiKey) return null;
    try {
      const url = geocodeUrl(address);
      const res = await fetchImpl(url);
      const body = await res.json();
      stats.geocodes++;
      if (body.status === "ZERO_RESULTS") {
        db.prepare("INSERT OR REPLACE INTO geocodes (address, lat, lng, at) VALUES (?, NULL, NULL, ?)").run(norm, now().toISOString());
        return null;
      }
      const loc = body.results?.[0]?.geometry?.location;
      if (body.status !== "OK" || !loc) throw new Error(`geocode ${body.status}: ${body.error_message || ""}`);
      db.prepare("INSERT OR REPLACE INTO geocodes (address, lat, lng, at) VALUES (?, ?, ?, ?)").run(norm, loc.lat, loc.lng, now().toISOString());
      return { lat: loc.lat, lng: loc.lng };
    } catch (e) {
      stats.failures++;
      log("geocoding failed:", e.message);
      return null;
    }
  }

  const geocodeUrl = (address) =>
    `${GEOCODE_URL}?address=${encodeURIComponent(address)}&region=us&bounds=${encodeURIComponent(AREA_BOUNDS)}&components=country:US&key=${encodeURIComponent(apiKey)}`;

  // Check an address someone is saving: { status: "found", lat, lng, formatted, exact, km } | { status: "not_found" } |
  // { status: "unknown" } (no key, or Google failed). "exact" is false when Google only found the street; km is the
  // distance from Monsey. An answer that is only a town, county or country counts as not found. An address without
  // its town that lands far away is tried again in Monsey ("12 Main St" is the one in Monsey, not upstate).
  async function lookup(address) {
    const text = spokenNumbers(String(address || "").trim());
    if (!text) return { status: "not_found" };
    if (!apiKey) return { status: "unknown" };
    try {
      let r = await lookupOnce(text);
      if (r.status !== "found" || r.km > AREA_KM) {
        const local = await lookupOnce(`${text}, Monsey, NY`);
        if (local.status === "found" && local.km <= AREA_KM) r = local;
      }
      if (r.status === "found") {
        const norm = String(address).trim().toLowerCase().replace(/\s+/g, " ");
        db.prepare("INSERT OR REPLACE INTO geocodes (address, lat, lng, at) VALUES (?, ?, ?, ?)").run(norm, r.lat, r.lng, now().toISOString());
      }
      return r;
    } catch (e) {
      stats.failures++;
      log("geocoding failed:", e.message);
      return { status: "unknown" };
    }
  }
  async function lookupOnce(text) {
    const body = await (await fetchImpl(geocodeUrl(text))).json();
    stats.geocodes++;
    if (body.status === "ZERO_RESULTS") return { status: "not_found" };
    const r = body.results?.[0];
    const loc = r?.geometry?.location;
    if (body.status !== "OK" || !loc) throw new Error(`geocode ${body.status}: ${body.error_message || ""}`);
    if ((r.types || []).every((t) => VAGUE_TYPES.includes(t))) return { status: "not_found" };
    const exact = !r.partial_match && ["ROOFTOP", "RANGE_INTERPOLATED"].includes(r.geometry.location_type);
    const km = Math.round(Math.hypot((loc.lat - AREA_CENTER.lat) * 111, (loc.lng - AREA_CENTER.lng) * 84));
    return { status: "found", lat: loc.lat, lng: loc.lng, formatted: r.formatted_address || text, exact, km };
  }

  // Make sure these legs are in the cache. legs: [{ a, b, minute }] with point keys (null keys are skipped).
  async function ensure(legs) {
    if (!apiKey) return;
    const want = new Map(); // bucket -> Set of "a|b"
    for (const { a, b, minute } of legs) {
      if (!a || !b || a === b) continue;
      const bucket = bucketOf(minute);
      if (fresh(getTime.get(a, b, bucket))) continue;
      if (!want.has(bucket)) want.set(bucket, new Set());
      want.get(bucket).add(`${a}|${b}`);
    }
    for (const [bucket, pairs] of want) {
      // Group by origin, and ask for each origin chunk against the destinations it needs.
      const origins = [...new Set([...pairs].map((p) => p.split("|")[0]))];
      for (let i = 0; i < origins.length; i += MAX_SIDE) {
        const os = origins.slice(i, i + MAX_SIDE);
        const ds = [...new Set([...pairs].filter((p) => os.includes(p.split("|")[0])).map((p) => p.split("|")[1]))];
        for (let j = 0; j < ds.length; j += MAX_SIDE) await matrix(os, ds.slice(j, j + MAX_SIDE), bucket);
      }
    }
  }

  async function matrix(origins, destinations, bucket) {
    const wp = (k) => {
      const [latitude, longitude] = parseKey(k);
      return { waypoint: { location: { latLng: { latitude, longitude } } } };
    };
    const body = {
      origins: origins.map(wp),
      destinations: destinations.map(wp),
      travelMode: "DRIVE",
      routingPreference: bucket < 0 ? "TRAFFIC_UNAWARE" : "TRAFFIC_AWARE",
    };
    if (bucket >= 0) body.departureTime = departureFor(bucket, now(), timeZone).toISOString();
    try {
      const res = await fetchImpl(MATRIX_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "originIndex,destinationIndex,duration,distanceMeters,condition",
        },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      if (!res.ok || !Array.isArray(out)) throw new Error(`route matrix ${res.status}: ${out?.error?.message || ""}`);
      stats.matrixRequests++;
      const at = now().toISOString();
      for (const el of out) {
        stats.elements++;
        if (el.condition !== "ROUTE_EXISTS" || !el.duration) continue;
        const a = origins[el.originIndex ?? 0];
        const b = destinations[el.destinationIndex ?? 0];
        putTime.run(a, b, bucket, Math.round((parseFloat(el.duration) / 60) * 10) / 10, el.distanceMeters ?? null, at);
      }
    } catch (e) {
      stats.failures++;
      log("travel times failed:", e.message);
    }
  }

  // Minutes for a leg from the cache: this hour, else the nearest hour we have, else an estimate.
  function minutes(a, b, minute) {
    if (!a || !b || a === b) return { minutes: estimateMinutes(a, b), estimated: !(a && b) };
    const bucket = bucketOf(minute);
    const row = getTime.get(a, b, bucket) || anyTime.get(a, b, bucket);
    if (row) return { minutes: row.minutes, estimated: false };
    return { minutes: estimateMinutes(a, b), estimated: true };
  }

  return { geocode, lookup, ensure, minutes, stats, hasKey: !!apiKey, traffic };
}
