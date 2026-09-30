// Adapter: Hatch Tennis Club — bespoke public API, no auth.
//   GET /api/courts                         -> [{ id, name, opening_time, closing_time, ... }]
//   GET /api/courts/:id/availability?date=  -> { booked:[{start,end}], blocks:[...] }  (UTC)
// The API returns BOOKED intervals; we invert to FREE hours in Bangkok time.

const UA = 'tennis-finder/0.1 (personal court-finder; contact via app)';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Hatch ${res.status} ${url}`);
  return res.json();
}

/** @returns {Promise<Record<string, number[]>>} courtLabel -> sorted free hours */
export async function fetchHatch(source, date) {
  const base = source.base;
  const courts = await getJson(`${base}/api/courts`);
  const active = courts.filter((c) => c.is_active !== false);
  const out = {};

  await Promise.all(active.map(async (c) => {
    const av = await getJson(`${base}/api/courts/${c.id}/availability?date=${date}`);
    const slotMin = av.slot_minutes ?? c.slot_minutes ?? 60;
    if (slotMin !== 60) throw new Error(`hatch: ${slotMin}-min slots don't fit an hourly grid`);
    const openH = parseInt(av.opening_time ?? c.opening_time ?? '06:00', 10);
    let closeH = parseInt(av.closing_time ?? c.closing_time ?? '23:00', 10);
    if (closeH <= openH) closeH += 24; // '00:00:00' closing = midnight, not hour 0
    // An hour is busy if ANY booking/block overlaps it — a record can span 2+ hours or
    // start off the hour. Intervals are UTC; the hour grid is Bangkok local (UTC+7).
    const intervals = [];
    let wholeDayBlocked = false;
    for (const b of [...(av.booked || []), ...(av.blocks || [])]) {
      const s = Date.parse(b?.start), e = Date.parse(b?.end);
      if (Number.isNaN(s) || Number.isNaN(e)) {
        // A block we can't read (never seen one yet): don't send anyone to a court
        // that might be closed for maintenance — treat the day as unavailable.
        wholeDayBlocked = true;
        console.warn(`hatch: unreadable booking/block on court ${c.id} ${date}:`, JSON.stringify(b));
        continue;
      }
      intervals.push([s, e]);
    }
    const [y, m, d] = date.split('-').map(Number);
    const free = [];
    if (!wholeDayBlocked) {
      for (let h = openH; h < closeH; h++) {
        const hs = Date.UTC(y, m - 1, d, h) - 7 * 3_600_000, he = hs + 3_600_000;
        if (!intervals.some(([s, e]) => s < he && e > hs)) free.push(h);
      }
    }
    out[(c.name || `Court ${c.id}`).trim()] = free;
  }));

  return out;
}
