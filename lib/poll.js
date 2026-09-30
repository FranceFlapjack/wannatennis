// Poller: walk the catalog, fetch every AUTO venue for the next N days, diff the
// result against the previous snapshot to detect booked->free transitions, and write
// one snapshot JSON. Manual venues carry no availability — they're rendered as
// self-check cards straight from the catalog. The web server reads the snapshot;
// the poll runs on a timer so the server never blocks on a slow venue.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CATALOG } from '../catalog.js';
import { bkkDateRange } from './time.js';
import { fetchHatch } from '../adapters/hatch.js';
import { fetchOkrabook } from '../adapters/okrabook.js';
import { fetchReservationSystem } from '../adapters/reservation-system.js';
import { fetchSkedda } from '../adapters/skedda.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_PATH = join(HERE, '..', 'data', 'snapshot.json');
const DAYS = 7;

export const ADAPTERS = {
  hatch: fetchHatch,
  okrabook: fetchOkrabook,
  reservationSystem: fetchReservationSystem,
  skedda: fetchSkedda,
};

export async function pollVenue(venue, dates) {
  const adapter = ADAPTERS[venue.source.type];
  if (!adapter) return { live: false, byDate: {}, errors: [], errorDates: [] }; // manual
  const byDate = {};
  const errors = [];
  const errorDates = [];
  for (const date of dates) {
    try {
      byDate[date] = await adapter(venue.source, date);
    } catch (e) {
      // A failed check is NOT "no free courts" — record it so the UI can say so.
      errors.push(`${date}: ${e.message}`);
      errorDates.push(date);
      byDate[date] = null;
      console.warn(`poll: ${venue.id} ${date} failed — ${e.message}`);
    }
  }
  return { live: true, byDate, errors, errorDates };
}

/**
 * For days that failed this poll, reuse the previous poll's data as the diff BASELINE
 * (so a short outage doesn't make us lose track of just-freed slots). It is never shown:
 * the server hides errored days and says "couldn't check" instead.
 */
export function fillFailedFromPrev(venues, prev) {
  for (const [id, info] of Object.entries(venues)) {
    for (const date of info.errorDates || []) {
      info.byDate[date] = prev?.venues?.[id]?.byDate?.[date] ?? {};
    }
  }
  return venues;
}

/**
 * Diff the new availability against the previous snapshot and stamp each currently-free
 * (venue,date,court,hour) with when it became free. Pure & testable.
 *
 *   - was free before        -> carry the old freedAt forward (don't reset)
 *   - was BOOKED before      -> a real booked->free transition: freedAt = now
 *   - court/date not in prev  -> unknown baseline: leave unstamped (never a false "just freed")
 *
 * Only stamped hours are stored, so absence == "not newly freed".
 * @returns freed[venueId][date][courtLabel][hour] = ISO
 */
export function computeFreed(prev, venues, nowISO) {
  const freed = {};
  for (const [id, info] of Object.entries(venues)) {
    if (!info.live) continue;
    const prevVenue = prev?.venues?.[id];
    const prevFreed = prevVenue?.freed || {};
    const vOut = {};
    for (const [date, byCourt] of Object.entries(info.byDate || {})) {
      const prevByCourt = prevVenue?.byDate?.[date]; // undefined => new date in window
      const dOut = {};
      for (const [court, hours] of Object.entries(byCourt)) {
        const prevHours = prevByCourt?.[court]; // undefined => new/unknown court baseline
        if (prevHours === undefined) continue;  // unknown baseline -> stamp nothing
        const prevSet = new Set(prevHours);
        const cOut = {};
        for (const h of hours) {
          if (prevSet.has(h)) {
            const carried = prevFreed?.[date]?.[court]?.[h];
            if (carried) cOut[h] = carried;          // still free -> keep original stamp
          } else {
            cOut[h] = nowISO;                        // booked -> free : brand new
          }
        }
        if (Object.keys(cOut).length) dOut[court] = cOut;
      }
      if (Object.keys(dOut).length) vOut[date] = dOut;
    }
    if (Object.keys(vOut).length) freed[id] = vOut;
  }
  return freed;
}

// A previous poll only counts as a diff baseline if it's recent. After the server was
// off for hours or days, "booked then, free now" means "opened at some point while we
// weren't looking" — not "just freed" — so we'd flag old openings and (later) send
// stale LINE alerts. Skip one cycle instead: the next poll compares fresh with fresh.
export const MAX_BASELINE_AGE_MS = 15 * 60 * 1000;
export function usableBaseline(prev, nowMs = Date.now()) {
  if (!prev?.generatedAt) return null;
  return nowMs - Date.parse(prev.generatedAt) <= MAX_BASELINE_AGE_MS ? prev : null;
}

async function readPrev() {
  try { return JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8')); }
  catch { return null; }
}

export async function poll() {
  const prev = usableBaseline(await readPrev());
  const dates = bkkDateRange(DAYS);
  const venues = {};
  await Promise.all(CATALOG.map(async (v) => {
    const r = await pollVenue(v, dates);
    venues[v.id] = { live: r.live, byDate: r.byDate, errors: r.errors, errorDates: r.errorDates };
  }));
  fillFailedFromPrev(venues, prev);

  const now = new Date().toISOString();
  const freed = computeFreed(prev, venues, now);
  for (const [id, vFreed] of Object.entries(freed)) venues[id].freed = vFreed;

  const snapshot = { generatedAt: now, dates, venues };
  // Write-then-rename is atomic: a crash mid-write can't leave a half-written snapshot.
  await mkdir(dirname(SNAPSHOT_PATH), { recursive: true });       // fresh checkout: no data/ yet
  await writeFile(SNAPSHOT_PATH + '.tmp', JSON.stringify(snapshot));
  await rename(SNAPSHOT_PATH + '.tmp', SNAPSHOT_PATH);
  return snapshot;
}

// Allow `node lib/poll.js` for a one-off refresh.
if (process.argv[1] && process.argv[1].endsWith('poll.js')) {
  poll().then((s) => {
    for (const v of CATALOG) {
      const info = s.venues[v.id];
      const days = Object.values(info.byDate).filter(Boolean);
      const totalHrs = days.reduce((t, byCourt) =>
        t + Object.values(byCourt).reduce((a, h) => a + h.length, 0), 0);
      // stamps carry forward while a slot stays free, so split new-this-poll from older ones
      const stamps = Object.values(info.freed || {}).flatMap((byCourt) =>
        Object.values(byCourt).flatMap((hrs) => Object.values(hrs)));
      const newNow = stamps.filter((iso) => iso === s.generatedAt).length;
      console.log(`${v.id.padEnd(8)} live=${info.live} freeCourtHours(7d)=${totalHrs}` +
        ` freedThisPoll=${newNow} freedEarlierStillFree=${stamps.length - newNow}` +
        (info.errors.length ? ` errors=${info.errors.length}` : ''));
    }
    console.log('wrote', SNAPSHOT_PATH);
  }).catch((e) => { console.error(e); process.exit(1); });
}
