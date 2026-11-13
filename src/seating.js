// Seating: which rows each booking sits in, so that every row follows the rules at every moment of the route.
//
// Rules (spec section 3):
// - Front passenger seat: 1 seat, men only.
// - Row 2 and row 3: 3 seats each, all men or all women. No mixing.
// - A booking whose caller said its men and women may sit together ("together") may share a row between its own
//   members. A mixed row never holds anyone from another booking.
// - A booking's members keep the same seats from pickup to drop-off.
// - Seat rules between two people (relations.js, set in the dashboard): "apart" never shares a row (not even in the
//   same booking); "together" lets that man and woman share a row, also from two bookings. A mixed row still never
//   holds a man and a woman who aren't allowed side by side, so nobody else may be in it with them.
//
// A booking may name its riders: people: [{ id, gender, apart: [ids], together: [ids] }]. Only named people with a
// rule about someone else in the plan are seated one by one; everyone else is counted (men, women include them).
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

// Rules between the named riders of all bookings: who must sit apart, which man and woman may share a row.
function rulesOf(bookings) {
  const gender = new Map();
  for (const b of bookings) for (const p of b.people || []) gender.set(p.id, p.gender);
  const apart = new Set();
  const together = new Set();
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const tracked = new Set();
  for (const b of bookings) {
    for (const p of b.people || []) {
      for (const o of p.apart || []) if (gender.has(o) && o !== p.id) { apart.add(key(p.id, o)); tracked.add(p.id).add(o); }
      for (const o of p.together || []) if (gender.has(o) && o !== p.id) { together.add(key(p.id, o)); tracked.add(p.id).add(o); }
    }
  }
  return { gender, tracked, isApart: (a, b) => apart.has(key(a, b)), mayMix: (a, b) => together.has(key(a, b)) };
}

// The named people of a booking that are seated one by one.
const trackedOf = (b, rules) => (b.people || []).filter((p) => rules.tracked.has(p.id));

// The ways one booking can sit, on its own, ignoring everyone else. Fewer rows used comes first, so families stay
// together when they can.
function optionsFor(booking, layout, rules) {
  const named = trackedOf(booking, rules);
  const out = [];
  const seen = new Set();
  const place = (i, who, used) => {
    if (i === named.length) {
      const anonMen = booking.men - named.filter((p) => p.gender === "m").length;
      const anonWomen = booking.women - named.filter((p) => p.gender === "f").length;
      const free = layout.map((r, k) => r.seats - used[k]);
      const men = spreads(anonMen, free);
      for (const m of men) {
        const women = spreads(anonWomen, layout.map((r, k) => (r.menOnly ? 0 : free[k] - m[k])));
        for (const w of women) {
          const opt = { men: [], women: [], who: who.map((x) => x.slice().sort()) };
          let ok = true;
          layout.forEach((r, k) => {
            const nm = who[k].filter((id) => rules.gender.get(id) === "m").length;
            opt.men[k] = m[k] + nm;
            opt.women[k] = w[k] + who[k].length - nm;
            if (ok && !rowOk(r, [{ booking, men: opt.men[k], women: opt.women[k], who: opt.who[k] }], rules)) ok = false;
          });
          if (!ok) continue;
          const sig = JSON.stringify(opt);
          if (seen.has(sig)) continue;
          seen.add(sig);
          opt.rowsUsed = opt.men.filter((x, k) => x + opt.women[k] > 0).length;
          out.push(opt);
        }
      }
      return;
    }
    const p = named[i];
    layout.forEach((r, k) => {
      if (used[k] >= r.seats || (r.menOnly && p.gender !== "m")) return;
      used[k]++;
      who[k].push(p.id);
      place(i + 1, who, used);
      who[k].pop();
      used[k]--;
    });
  };
  place(0, layout.map(() => []), layout.map(() => 0));
  out.sort((a, b) => a.rowsUsed - b.rowsUsed);
  return out;
}

// Is one row valid with these occupants? occ = [{ booking, men, women, who: [named ids seated one by one] }]
function rowOk(row, occ, rules) {
  let men = 0;
  let women = 0;
  const ids = [];
  for (const o of occ) {
    men += o.men;
    women += o.women;
    ids.push(...(o.who || []));
  }
  if (men + women > row.seats) return false;
  if (row.menOnly && women > 0) return false;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (rules.isApart(ids[i], ids[j])) return false;
  if (men > 0 && women > 0) {
    // A mixed row: every man in it may sit by every woman in it. Inside a booking marked "together" that is anyone;
    // otherwise only a named man and woman with a "together" rule.
    const inRow = occ.filter((o) => o.men + o.women > 0);
    const named = (o, g) => (o.who || []).filter((id) => rules.gender.get(id) === g);
    for (const a of inRow) {
      if (!a.men) continue;
      for (const b of inRow) {
        if (!b.women) continue;
        if (a.booking === b.booking && a.booking.together) continue;
        const ms = named(a, "m");
        const ws = named(b, "f");
        if (ms.length < a.men || ws.length < b.women) return false;
        if (!ms.every((m) => ws.every((w) => rules.mayMix(m, w)))) return false;
      }
    }
  }
  return true;
}

function overlaps(a, b) {
  return a.pickup < b.dropoff && b.pickup < a.dropoff;
}

// Find a seat plan. bookings: [{ id, men, women, together, pickup, dropoff, people? }] with pickup < dropoff as stop
// indexes. Bookings that already have `seats` (a plan from before) keep them when possible, so riders on board never
// move. Returns { ok: true, plan: { [id]: { [rowId]: { men, women, people? } } } } or { ok: false, reason, at }.
export function planSeats(bookings, layout = DEFAULT_LAYOUT) {
  for (const b of bookings) {
    // No men and no women is a package only (bookings.js): it takes no seats.
    if (!(b.men >= 0 && b.women >= 0)) return { ok: false, reason: "empty_booking", id: b.id };
    if (!(b.pickup < b.dropoff)) return { ok: false, reason: "bad_stops", id: b.id };
    const people = b.people || [];
    if (people.filter((p) => p.gender === "m").length > b.men || people.filter((p) => p.gender === "f").length > b.women) {
      return { ok: false, reason: "bad_people", id: b.id };
    }
  }
  // Quick check: total people on board at each stop.
  const cap = capacity(layout);
  const lastStop = Math.max(0, ...bookings.map((b) => b.dropoff));
  for (let s = 0; s < lastStop; s++) {
    const onBoard = bookings.filter((b) => b.pickup <= s && s < b.dropoff);
    const people = onBoard.reduce((n, b) => n + b.men + b.women, 0);
    if (people > cap) return { ok: false, reason: "over_capacity", at: s };
  }

  const rules = rulesOf(bookings);
  // Order: fixed plans first, then the bookings with the fewest options and the most people.
  const items = bookings.map((b) => {
    let opts = optionsFor(b, layout, rules);
    if (b.seats) {
      const same = (o) => layout.every((r, i) => (b.seats[r.id]?.men || 0) === o.men[i] && (b.seats[r.id]?.women || 0) === o.women[i]);
      const samePeople = (o) => layout.every((r, i) => JSON.stringify([...(b.seats[r.id]?.people || [])].sort()) === JSON.stringify(o.who[i]));
      const fixed = opts.find((o) => same(o) && samePeople(o)) || opts.find(same);
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
        const occ = here.map(([ob, o]) => ({ booking: ob, men: o.men[i], women: o.women[i], who: o.who[i] }));
        occ.push({ booking: b, men: opt.men[i], women: opt.women[i], who: opt.who[i] });
        if (!rowOk(layout[i], occ, rules)) return false;
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
      if (o.men[i] + o.women[i] === 0) return;
      plan[b.id][r.id] = { men: o.men[i], women: o.women[i] };
      if (o.who[i].length) plan[b.id][r.id].people = o.who[i];
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
