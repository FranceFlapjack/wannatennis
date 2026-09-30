// The slot engine. Canonical unit is a 1-hour block, keyed by start hour (0..23).
// A court is "free at hour H" == you can play the hour [H:00, H+1:00) on it.
//
// Adapters normalise every venue into: { [courtLabel]: number[] }  // sorted free hours
// From that we answer the ONLY question the UI asks:
//   "for a run length N, which start hours have at least one court free for N
//    consecutive hours, and how many courts offer each?"
//
// N is a user-chosen FILTER (1, 2, 3, ...), not a fixed rule.

/**
 * @param {Record<string, number[]>} freeByCourt
 * @param {number} minHours  run length the user wants (>=1)
 * @param {Set<string>} [freshHours]  "courtLabel:hour" pairs that just freed up
 * @returns {{ hour:number, courts:number, names:string[], fresh:boolean }[]}  start hours, ascending
 */
export function qualifyingStarts(freeByCourt, minHours, freshHours) {
  const n = Math.max(1, minHours | 0);
  const startCourts = new Map(); // startHour -> court names that offer N hrs from here
  const startFresh = new Set(); // startHours where a contributing court's run STARTS fresh

  for (const [court, hours] of Object.entries(freeByCourt)) {
    const free = new Set(hours);
    // A start H qualifies for this court if H, H+1, ... H+n-1 are all free.
    for (const h of hours) {
      let ok = true;
      for (let k = 1; k < n; k++) if (!free.has(h + k)) { ok = false; break; }
      if (!ok) continue;
      if (!startCourts.has(h)) startCourts.set(h, []);
      startCourts.get(h).push(court);
      if (freshHours && freshHours.has(`${court}:${h}`)) startFresh.add(h);
    }
  }
  const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true }); // Court 2 before Court 11
  return [...startCourts.entries()]
    .map(([hour, names]) => ({ hour, courts: names.length, names: names.sort(natural), fresh: startFresh.has(hour) }))
    .sort((a, b) => a.hour - b.hour);
}

/** Total distinct free court-hours (for the summary line). */
export function totalFreeCourtHours(freeByCourt) {
  return Object.values(freeByCourt).reduce((s, hrs) => s + hrs.length, 0);
}

/** How many distinct courts have at least one free hour. */
export function courtsWithAny(freeByCourt) {
  return Object.values(freeByCourt).filter((h) => h.length > 0).length;
}

/** 'HH:00' */
export function hhmm(hour) {
  return String(hour).padStart(2, '0') + ':00';
}
