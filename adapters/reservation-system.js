// Adapter: the SvelteKit "Reservation System" platform (GOAT57 runs on it).
// Availability is fully public — no login, no CSRF:
//   GET /availability/<itemType>/__data.json?date=YYYY-MM-DD
// The body is SvelteKit's devalue format: a flat pool where numbers are indices
// into that same pool, so it must be hydrated before use.
//
// Unlike Hatch (UTC) this one reports LOCAL Bangkok times already, and it tells us
// its own business hours + holidays, so we derive the day grid from the venue itself.
const UA = 'tennis-finder/0.1 (personal court-finder; contact via app)';

/** Resolve SvelteKit's index-referenced pool into plain JS. */
function hydrate(pool) {
  const seen = new Map();
  const walk = (i) => {
    if (i === -1) return undefined;
    if (i === -2) return null;
    if (i === -3) return NaN;
    if (typeof i !== 'number') return i;
    if (seen.has(i)) return seen.get(i);
    const v = pool[i];
    if (Array.isArray(v)) { const o = []; seen.set(i, o); for (const x of v) o.push(walk(x)); return o; }
    if (v && typeof v === 'object') { const o = {}; seen.set(i, o); for (const [k, x] of Object.entries(v)) o[k] = walk(x); return o; }
    seen.set(i, v); return v;
  };
  return walk(0);
}

/** '23:00' -> 23 ; '00:00' as a CLOSING time means midnight -> 24 */
const toHour = (hhmm, isEnd = false) => {
  const h = parseInt(String(hhmm).slice(0, 2), 10);
  return isEnd && h === 0 ? 24 : h;
};

/** @returns {Promise<Record<string, number[]>>} courtLabel -> sorted free hours */
export async function fetchReservationSystem(source, date) {
  const itemType = source.itemType || 'court';
  const url = `${source.base}/availability/${itemType}/__data.json?date=${date}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`reservation-system ${res.status} ${url}`);
  const json = await res.json();

  const node = json.nodes?.find((n) => n?.data?.[0] && n.data[0].items !== undefined);
  if (!node) throw new Error('reservation-system: no availability node in payload');
  const d = hydrate(node.data);

  // Closed for a holiday? Then nothing is free.
  const [y, m, dd] = date.split('-').map(Number);
  const md = date.slice(5);
  // Mirrors the venue's own page logic: a holiday is either "closed" or "modified"
  // (special hours in modifiedHours); otherwise the weekday schedule, which has isOpen.
  const allClosed = () => Object.fromEntries((d.items || []).map((c) => [(c.name || c.id).trim(), []]));
  const holiday = (d.holidays || []).find((h) =>
    h && !h.deletedAt && (h.date === date || (h.isRecurringYearly && String(h.date).slice(5) === md)));
  if (holiday?.type === 'closed') return allClosed();

  const dow = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
  const cfg = d.businessHoursConfig || {};
  // Our grid is whole hours. Refuse (-> "couldn't check") rather than show wrong times.
  const slotMin = cfg.defaultSlotDurationMinutes ?? 60, buffer = cfg.bufferBetweenBookingsMinutes ?? 0;
  if (slotMin !== 60 || buffer !== 0) {
    throw new Error(`reservation-system: ${slotMin}-min slots / ${buffer}-min buffer don't fit an hourly grid`);
  }
  const day = (cfg.weeklySchedule || []).find((w) => w.dayOfWeek === dow);
  let windows;
  if (holiday) windows = holiday.modifiedHours || [];
  else if (day && day.isOpen === false) return allClosed();
  else windows = day?.timeSlots?.length ? day.timeSlots : [{ startTime: '06:00', endTime: '23:00' }];

  const openHours = [];
  for (const w of windows) {
    for (let h = toHour(w.startTime); h < toHour(w.endTime, true); h++) openHours.push(h);
  }

  // Booked hours per court id (already local time).
  const bookedBy = new Map();
  for (const b of d.bookings || []) {
    for (const it of b.items || []) {
      if (it.bookingDate && it.bookingDate !== date) continue;
      if (!bookedBy.has(it.itemId)) bookedBy.set(it.itemId, new Set());
      const s = toHour(it.startTime), e = toHour(it.endTime, true);
      for (let h = s; h < e; h++) bookedBy.get(it.itemId).add(h);
    }
  }

  const out = {};
  for (const c of d.items || []) {
    if (c.type && itemType && c.type !== itemType) continue;
    const busy = bookedBy.get(c.id) || new Set();
    out[(c.name || c.id).trim()] = openHours.filter((h) => !busy.has(h));
  }
  return out;
}
