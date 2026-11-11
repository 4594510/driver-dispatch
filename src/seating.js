// Seating: which rows each booking sits in, so that every row follows the rules at every moment of the route.
//
// Rules (spec section 3):
// - Front passenger seat: 1 seat, men only.
// - Row 2 and row 3: 3 seats each, all men or all women. No mixing.
// - A booking whose caller said its men and women may sit together ("together") may share a row between its own
//   members. A mixed row never holds anyone from another booking.
// - A booking's members keep the same seats from pickup to drop-off.
//
// A route is a list of stops; a booking is on board from its pickup stop up to (not including) its drop-off stop.
// The engine looks for a seat plan for all bookings at once (small search: at most 7 people are ever on board).

export const DEFAULT_LAYOUT = [
  { id: "front", seats: 1, menOnly: true },
  { id: "row2", seats: 3, menOnly: false },
  { id: "row3", seats: 3, menOnly: false },
];

export function capacity(layout = DEFAULT_LAYOUT) {
  return layout.reduce((n, r) => n + r.seats, 0);
}

// Every way to spread `count` people over the rows (an array of per-row counts), at most `limits[i]` in row i.
function spreads(count, limits) {
  const out = [];
  const cur = new Array(limits.length).fill(0);
  const walk = (i, left) => {
    if (i === limits.length) {
      if (left === 0) out.push(cur.slice());
      return;
    }
    for (let k = Math.min(left, limits[i]); k >= 0; k--) {
      cur[i] = k;
      walk(i + 1, left - k);
    }
    cur[i] = 0;
  };
  walk(0, count);
  return out;
}

// The ways one booking can sit, on its own, ignoring everyone else. Fewer rows used comes first, so families stay
// together when they can.
function optionsFor(booking, layout) {
  const men = spreads(booking.men, layout.map((r) => r.seats));
  const women = spreads(booking.women, layout.map((r) => (r.menOnly ? 0 : r.seats)));
  const opts = [];
  for (const m of men) {
    for (const w of women) {
      let ok = true;
      for (let i = 0; i < layout.length && ok; i++) {
        if (m[i] + w[i] > layout[i].seats) ok = false;
        else if (m[i] > 0 && w[i] > 0 && !booking.together) ok = false;
      }
      if (ok) opts.push({ men: m, women: w, rowsUsed: m.filter((x, i) => x + w[i] > 0).length });
    }
  }
  opts.sort((a, b) => a.rowsUsed - b.rowsUsed);
  return opts;
}

// Is one row valid with these occupants? occ = [{ booking, men, women }]
function rowOk(row, occ) {
  let men = 0;
  let women = 0;
  for (const o of occ) {
    men += o.men;
    women += o.women;
  }
  if (men + women > row.seats) return false;
  if (row.menOnly && women > 0) return false;
  if (men > 0 && women > 0) {
    // A mixed row: only one booking in it, and that booking allows sitting together.
    const inRow = occ.filter((o) => o.men + o.women > 0);
    if (inRow.length !== 1 || !inRow[0].booking.together) return false;
  }
  return true;
}

function overlaps(a, b) {
  return a.pickup < b.dropoff && b.pickup < a.dropoff;
}

// Find a seat plan. bookings: [{ id, men, women, together, pickup, dropoff }] with pickup < dropoff as stop indexes.
// Bookings that already have `seats` (a plan from before) keep them when possible, so riders on board never move.
// Returns { ok: true, plan: { [id]: { [rowId]: { men, women } } } } or { ok: false, reason, at }.
export function planSeats(bookings, layout = DEFAULT_LAYOUT) {
  for (const b of bookings) {
    if (!(b.men >= 0 && b.women >= 0) || b.men + b.women === 0) return { ok: false, reason: "empty_booking", id: b.id };
    if (!(b.pickup < b.dropoff)) return { ok: false, reason: "bad_stops", id: b.id };
  }
  // Quick check: total people on board at each stop.
  const cap = capacity(layout);
  const lastStop = Math.max(0, ...bookings.map((b) => b.dropoff));
  for (let s = 0; s < lastStop; s++) {
    const onBoard = bookings.filter((b) => b.pickup <= s && s < b.dropoff);
    const people = onBoard.reduce((n, b) => n + b.men + b.women, 0);
    if (people > cap) return { ok: false, reason: "over_capacity", at: s };
  }

  // Order: fixed plans first, then the bookings with the fewest options and the most people.
  const items = bookings.map((b) => {
    let opts = optionsFor(b, layout);
    if (b.seats) {
      const fixed = opts.find((o) => layout.every((r, i) => (b.seats[r.id]?.men || 0) === o.men[i] && (b.seats[r.id]?.women || 0) === o.women[i]));
      if (fixed) opts = [fixed, ...opts.filter((o) => o !== fixed)];
    }
    return { b, opts };
  });
  items.sort((x, y) => (y.b.seats ? 1 : 0) - (x.b.seats ? 1 : 0) || x.opts.length - y.opts.length || y.b.men + y.b.women - (x.b.men + x.b.women));

  const chosen = new Map();
  const fits = (b, opt) => {
    const others = [...chosen.entries()].filter(([ob]) => overlaps(ob, b));
    // Check every stop where b is on board.
    for (let s = b.pickup; s < b.dropoff; s++) {
      const here = others.filter(([ob]) => ob.pickup <= s && s < ob.dropoff);
      for (let i = 0; i < layout.length; i++) {
        const occ = here.map(([ob, o]) => ({ booking: ob, men: o.men[i], women: o.women[i] }));
        occ.push({ booking: b, men: opt.men[i], women: opt.women[i] });
        if (!rowOk(layout[i], occ)) return false;
      }
    }
    return true;
  };
  const search = (k) => {
    if (k === items.length) return true;
    const { b, opts } = items[k];
    for (const opt of opts) {
      if (!fits(b, opt)) continue;
      chosen.set(b, opt);
      if (search(k + 1)) return true;
      chosen.delete(b);
    }
    return false;
  };
  if (!search(0)) return { ok: false, reason: "no_seating" };

  const plan = {};
  for (const [b, o] of chosen) {
    plan[b.id] = {};
    layout.forEach((r, i) => {
      if (o.men[i] + o.women[i] > 0) plan[b.id][r.id] = { men: o.men[i], women: o.women[i] };
    });
  }
  return { ok: true, plan };
}

// Seats taken and free in each row at each stop, for the driver app ("occupied and available seats at every stop").
export function seatsByStop(bookings, plan, layout = DEFAULT_LAYOUT) {
  const lastStop = Math.max(0, ...bookings.map((b) => b.dropoff));
  const out = [];
  for (let s = 0; s <= lastStop; s++) {
    const rows = layout.map((r) => {
      let men = 0;
      let women = 0;
      for (const b of bookings) {
        if (b.pickup <= s && s < b.dropoff) {
          men += plan[b.id]?.[r.id]?.men || 0;
          women += plan[b.id]?.[r.id]?.women || 0;
        }
      }
      return { row: r.id, men, women, free: r.seats - men - women };
    });
    out.push({ stop: s, rows });
  }
  return out;
}
