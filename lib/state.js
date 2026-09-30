// The view model: turns a poll snapshot into exactly what the page shows.
// Pure — no I/O, and "now" is a parameter — so every display rule here (past hours,
// midnight rollover, failed checks, indoor/outdoor, freshness) is unit-testable.
import { qualifyingStarts, totalFreeCourtHours, courtsWithAny } from './slots.js';
import { dateLabel } from './time.js';

export const FRESH_WINDOW_MS = 30 * 60 * 1000; // a slot counts as "just freed" for 30 min
const BKK_OFFSET_MS = 7 * 3_600_000;              // Thailand is UTC+7, no DST

/** Bangkok calendar date and hour for an instant. */
export function bkkClock(now = Date.now()) {
  const shifted = new Date(now + BKK_OFFSET_MS);
  return { today: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours() };
}

// Indoor/outdoor is decided per COURT (Beat has both): the court's own name wins
// ("Outdoor Tennis Court 11"), otherwise the venue's default.
export function courtIsIndoor(label, venue) {
  if (/outdoor/i.test(label)) return false;
  if (/indoor/i.test(label)) return true;
  return venue.indoor;
}

// Which court types a venue has — from its live court names, else the catalog.
export function venueTypes(v, snapshot) {
  const labels = new Set();
  for (const byCourt of Object.values(snapshot.venues[v.id]?.byDate || {})) {
    for (const label of Object.keys(byCourt || {})) labels.add(label);
  }
  if (labels.size) {
    const t = new Set([...labels].map((l) => (courtIsIndoor(l, v) ? 'indoor' : 'outdoor')));
    return ['indoor', 'outdoor'].filter((x) => t.has(x));
  }
  return v.types || [v.indoor ? 'indoor' : 'outdoor'];
}

export function filterPlace(freeByCourt, venue, place) {
  if (place !== 'indoor' && place !== 'outdoor') return freeByCourt;
  const want = place === 'indoor';
  return Object.fromEntries(Object.entries(freeByCourt).filter(([label]) => courtIsIndoor(label, venue) === want));
}

// Public, catalog-only venue info (no internal source config leaked).
export function venueCard(v, snapshot) {
  return {
    id: v.id, name: v.name, nameTh: v.nameTh,
    area: v.area, areaTh: v.areaTh, indoor: v.indoor, types: venueTypes(v, snapshot),
    lat: v.lat, lng: v.lng, coordsApprox: v.coordsApprox,
    bookingUrl: v.bookingUrl, bookingUrlForDate: v.bookingUrlForDate || null, lineUrl: v.lineUrl || null,
    phone: v.phone || null, note: v.note || null, bookBy: v.bookBy || 'online',
    live: snapshot.venues[v.id]?.live ?? false,
  };
}

// For today, an hour that has already started is not bookable — drop it.
export function dropPastHours(freeByCourt, date, clock) {
  if (date !== clock.today) return freeByCourt;
  const out = {};
  for (const [court, hours] of Object.entries(freeByCourt)) out[court] = hours.filter((h) => h > clock.hour);
  return out;
}

// "courtLabel:hour" set of slots stamped free within the freshness window.
export function freshSet(freedForDate, cutoffMs) {
  const set = new Set();
  if (!freedForDate) return set;
  for (const [court, hours] of Object.entries(freedForDate)) {
    for (const [hour, iso] of Object.entries(hours)) {
      if (Date.parse(iso) >= cutoffMs) set.add(`${court}:${hour}`);
    }
  }
  return set;
}

/** Everything the page needs for one filter setting. */
export function buildState(snapshot, catalog, { minHours = 1, place = 'all', now = Date.now() } = {}) {
  const clock = bkkClock(now);
  // Just after midnight the snapshot still starts at yesterday until the next poll —
  // never offer a day that's already over.
  const liveDates = snapshot.dates.filter((d) => d >= clock.today);
  const dates = liveDates.map((d) => ({ date: d, ...dateLabel(d), today: d === clock.today }));
  const cutoff = now - FRESH_WINDOW_MS;
  const venues = {};
  for (const v of catalog) {
    const info = snapshot.venues[v.id];
    const byDate = {};
    for (const date of liveDates) {
      // A day we couldn't check shows as an error, never as "no slots".
      const error = !!info?.errorDates?.includes(date);
      const freeByCourt = error ? {} : filterPlace(dropPastHours(info?.byDate?.[date] || {}, date, clock), v, place);
      const fresh = freshSet(info?.freed?.[date], cutoff);
      const starts = qualifyingStarts(freeByCourt, minHours, fresh);
      byDate[date] = {
        starts,
        freeCourtHours: totalFreeCourtHours(freeByCourt),
        courts: courtsWithAny(freeByCourt),
        hasFresh: starts.some((s) => s.fresh),
        error,
      };
    }
    venues[v.id] = { live: info?.live ?? false, byDate };
  }
  return { generatedAt: snapshot.generatedAt, minHours, place, dates, venues };
}
