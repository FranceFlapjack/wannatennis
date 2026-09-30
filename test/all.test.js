// Run: npm test   (Node's built-in runner — no dependencies)
// Every rule the app relies on, plus a regression test for each bug found so far.
// Venue adapters are tested against canned responses shaped like the real APIs,
// so these run offline and never touch the venues' servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualifyingStarts } from '../lib/slots.js';
import { buildState, bkkClock, venueTypes, FRESH_WINDOW_MS } from '../lib/state.js';
import { bkkDateRange, dateLabel } from '../lib/time.js';
import { computeFreed, fillFailedFromPrev, usableBaseline, MAX_BASELINE_AGE_MS } from '../lib/poll.js';
import { fetchHatch } from '../adapters/hatch.js';
import { fetchOkrabook } from '../adapters/okrabook.js';
import { fetchReservationSystem } from '../adapters/reservation-system.js';
import { fetchSkedda, occurrenceStarts } from '../adapters/skedda.js';

// Bangkok wall-clock -> epoch ms
const bkk = (date, h, min = 0) => Date.parse(`${date}T00:00:00Z`) + (h - 7) * 3_600_000 + min * 60_000;
const iso = (ms) => new Date(ms).toISOString();
const byHour = (starts) => Object.fromEntries(starts.map((s) => [s.hour, s.courts]));

// ─── slot engine ────────────────────────────────────────────────────────────
test('engine: N-hour runs must be on the SAME court', () => {
  const f = { A: [6, 7, 8, 18, 19], B: [18, 19, 20], C: [9] };
  assert.deepEqual(byHour(qualifyingStarts(f, 1)), { 6: 1, 7: 1, 8: 1, 9: 1, 18: 2, 19: 2, 20: 1 });
  assert.deepEqual(byHour(qualifyingStarts(f, 2)), { 6: 1, 7: 1, 18: 2, 19: 1 });
  assert.deepEqual(byHour(qualifyingStarts(f, 3)), { 6: 1, 18: 1 });
  // 18 on A and 19 on B are both free, but not one court for 2h starting at 19 on A
  assert.equal(qualifyingStarts({ A: [18], B: [19] }, 2).length, 0);
});

test('engine: each start lists WHICH courts, naturally ordered', () => {
  const r = qualifyingStarts({ 'Outdoor Tennis Court 11': [18, 19], 'Indoor Tennis Court 2': [18, 19], 'Indoor Tennis Court 10': [18] }, 2);
  assert.deepEqual(r, [{ hour: 18, courts: 2, names: ['Indoor Tennis Court 2', 'Outdoor Tennis Court 11'], fresh: false }]);
});

test('engine: fresh flag follows the court whose run starts on a just-freed hour', () => {
  const r = qualifyingStarts({ A: [6, 7, 8, 18, 19], B: [18, 19, 20] }, 2, new Set(['A:18']));
  assert.equal(r.find((s) => s.hour === 18).fresh, true);
  assert.equal(r.find((s) => s.hour === 6).fresh, false);
  assert.ok(qualifyingStarts({ A: [1] }, 1).every((s) => s.fresh === false));
});

// ─── time ───────────────────────────────────────────────────────────────────
test('time: date range starts on the Bangkok date, not the UTC date', () => {
  // 23:30 UTC on the 25th is already 06:30 on the 26th in Bangkok
  assert.deepEqual(bkkDateRange(2, Date.parse('2026-09-25T23:30:00Z')), ['2026-09-26', '2026-09-27']);
  assert.deepEqual(dateLabel('2026-09-26'), { dow: 'Sat', day: 26, mon: 'Sep' });
});

// ─── view model (lib/state.js) ──────────────────────────────────────────────
const venue = (id, extra = {}) => ({ id, name: id, indoor: true, ...extra });
const snap = (venues, dates) => ({ generatedAt: 'x', dates, venues });

test('state: today drops hours that have already started; other days untouched', () => {
  const s = snap({ v: { live: true, byDate: { '2026-10-01': { C1: [14, 15, 16, 20] }, '2026-10-02': { C1: [6, 14] } } } },
    ['2026-10-01', '2026-10-02']);
  const st = buildState(s, [venue('v')], { now: bkk('2026-10-01', 15, 5) });
  assert.deepEqual(byHour(st.venues.v.byDate['2026-10-01'].starts), { 16: 1, 20: 1 }); // 14 past, 15 in progress
  assert.deepEqual(byHour(st.venues.v.byDate['2026-10-02'].starts), { 6: 1, 14: 1 });
});

test('state: just after midnight, yesterday is never offered', () => {
  const s = snap({ v: { live: true, byDate: { '2026-09-30': { C1: [22] }, '2026-10-01': { C1: [9] } } } },
    ['2026-09-30', '2026-10-01']);
  const st = buildState(s, [venue('v')], { now: bkk('2026-10-01', 0, 3) });
  assert.deepEqual(st.dates.map((d) => d.date), ['2026-10-01']);
  assert.equal(st.dates[0].today, true);
  assert.equal(st.venues.v.byDate['2026-09-30'], undefined);
});

test('state: a failed check is an error, never "no slots" — even with baseline data present', () => {
  const s = snap({ v: { live: true, errorDates: ['2026-10-02'], byDate: { '2026-10-02': { C1: [9, 10] } } } }, ['2026-10-02']);
  const cell = buildState(s, [venue('v')], { now: bkk('2026-10-01', 12) }).venues.v.byDate['2026-10-02'];
  assert.equal(cell.error, true);
  assert.equal(cell.starts.length, 0); // the baseline is for diffing only, never shown
});

test('state: indoor/outdoor is per court, and the two always add up to all', () => {
  const courts = { 'Indoor Tennis Court 1': [18, 19], 'Outdoor Tennis Court 11': [18], 'Outdoor Tennis Court 12': [19] };
  const s = snap({ beat: { live: true, byDate: { '2026-10-02': courts } } }, ['2026-10-02']);
  const at = (place) => buildState(s, [venue('beat')], { place, now: bkk('2026-10-01', 12) }).venues.beat.byDate['2026-10-02'].starts;
  const sum = (st) => st.reduce((a, x) => a + x.courts, 0);
  assert.deepEqual(byHour(at('indoor')), { 18: 1, 19: 1 });
  assert.deepEqual(byHour(at('outdoor')), { 18: 1, 19: 1 });
  assert.equal(sum(at('all')), sum(at('indoor')) + sum(at('outdoor')));
  assert.deepEqual(venueTypes(venue('beat'), s), ['indoor', 'outdoor']);
  assert.deepEqual(venueTypes(venue('cv', { indoor: false, types: ['indoor', 'outdoor'] }), snap({}, [])), ['indoor', 'outdoor']);
});

test('state: 🔔 only within the freshness window', () => {
  const now = bkk('2026-10-01', 12);
  const freed = { C1: { 18: iso(now - 10 * 60_000), 19: iso(now - FRESH_WINDOW_MS - 60_000) } };
  const s = snap({ v: { live: true, byDate: { '2026-10-02': { C1: [18, 19] } }, freed: { '2026-10-02': freed } } }, ['2026-10-02']);
  const starts = buildState(s, [venue('v')], { now }).venues.v.byDate['2026-10-02'].starts;
  assert.equal(starts.find((x) => x.hour === 18).fresh, true);
  assert.equal(starts.find((x) => x.hour === 19).fresh, false);
});

test('state: bkkClock gives the Bangkok date/hour', () => {
  assert.deepEqual(bkkClock(Date.parse('2026-09-30T17:30:00Z')), { today: '2026-10-01', hour: 0 });
});

// ─── change detection (lib/poll.js) ─────────────────────────────────────────
test('diff: booked→free is stamped, still-free carries its stamp, re-freed gets a new one', () => {
  const D = '2026-10-02';
  const prev = { venues: { h: { live: true, byDate: { [D]: { A: [6, 7], B: [9] } }, freed: {} } } };
  const now = { h: { live: true, byDate: { [D]: { A: [6, 7, 18], B: [9] } } } };
  const f1 = computeFreed(prev, now, 'T1');
  assert.equal(f1.h[D].A[18], 'T1');
  assert.equal(f1.h[D].A[6], undefined);
  assert.equal(f1.h[D].B, undefined);
  const f2 = computeFreed({ venues: { h: { ...now.h, freed: f1.h } } }, now, 'T2');
  assert.equal(f2.h[D].A[18], 'T1');
  const booked = { venues: { h: { live: true, byDate: { [D]: { A: [6, 7], B: [9] } }, freed: {} } } };
  assert.equal(computeFreed(booked, now, 'T3').h[D].A[18], 'T3');
});

test('diff: no baseline (first poll, new date, new court name) never produces a badge', () => {
  const now = { h: { live: true, byDate: { '2026-10-05': { A: [6, 7] } } } };
  assert.deepEqual(computeFreed(null, now, 'T'), {});
  assert.deepEqual(computeFreed({ venues: { h: { live: true, byDate: { '2026-10-04': { A: [] } } } } }, now, 'T'), {});
  // regression: Beat's courts used to be relabelled per day -> phantom badges
  assert.deepEqual(computeFreed({ venues: { h: { live: true, byDate: { '2026-10-05': { 'Court 3': [] } } } } }, now, 'T'), {});
});

test('poll: a days-old snapshot is not a baseline (regression: 3-day restart flagged old openings as 🔔)', () => {
  const now = Date.parse('2026-09-29T06:48:29Z');
  assert.equal(usableBaseline({ generatedAt: '2026-09-26T15:50:00Z' }, now), null);
  const recent = { generatedAt: new Date(now - 5 * 60_000).toISOString() };
  assert.equal(usableBaseline(recent, now), recent);
  assert.equal(usableBaseline({ generatedAt: new Date(now - MAX_BASELINE_AGE_MS - 1).toISOString() }, now), null);
  assert.equal(usableBaseline(null, now), null);
});

test('poll: a failed day keeps the last good data as its diff baseline', () => {
  const prev = { venues: { h: { byDate: { d1: { A: [9] } } } } };
  const venues = { h: { live: true, errorDates: ['d1', 'd2'], byDate: { d1: null, d2: null } } };
  fillFailedFromPrev(venues, prev);
  assert.deepEqual(venues.h.byDate.d1, { A: [9] });
  assert.deepEqual(venues.h.byDate.d2, {});
});

// ─── adapters, against canned responses ─────────────────────────────────────
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body),
  headers: { getSetCookie: () => ['sess=abc; path=/'], get: () => null } });
const html = (body) => ({ ok: true, status: 200, text: async () => body,
  headers: { getSetCookie: () => ['laravel_session=abc; path=/'], get: () => null } });
const quiet = (fn) => async () => { const w = console.warn; console.warn = () => {}; try { await fn(); } finally { console.warn = w; } };

// Hatch: UTC booked intervals
const hatchCourt = { id: 1, name: 'Court 1', is_active: true, slot_minutes: 60, opening_time: '06:00:00', closing_time: '23:00:00' };
async function hatch(av, court = hatchCourt, date = '2026-10-03') {
  globalThis.fetch = async (url) => json(url.endsWith('/api/courts') ? [court] : { opening_time: '06:00:00', closing_time: '23:00:00', blocks: [], ...av });
  return (await fetchHatch({ base: 'https://h.test' }, date))['Court 1'];
}
const B = (h, m = 0) => iso(bkk('2026-10-03', h, m));

test('hatch: a 1h booking at 06:00 Bangkok (23:00 UTC the day before)', async () => {
  const r = await hatch({ booked: [{ start: B(6), end: B(7) }] });
  assert.ok(!r.includes(6) && r.includes(7) && r.length === 16);
});
test('hatch: one 2-hour booking blocks BOTH hours (regression)', async () => {
  const r = await hatch({ booked: [{ start: B(10), end: B(12) }] });
  assert.ok(!r.includes(10) && !r.includes(11) && r.includes(12));
});
test('hatch: an off-the-hour booking blocks every hour it touches', async () => {
  const r = await hatch({ booked: [{ start: B(10, 30), end: B(11, 30) }] });
  assert.ok(!r.includes(10) && !r.includes(11) && r.includes(12));
});
test('hatch: closing at 00:00 means midnight, not "closed all day" (regression)', async () => {
  const r = await hatch({ opening_time: '06:00:00', closing_time: '00:00:00', booked: [] });
  assert.equal(r.length, 18);
  assert.equal(r.at(-1), 23);
});
test('hatch: an unreadable block makes the day unavailable rather than wrongly free', quiet(async () => {
  assert.deepEqual(await hatch({ booked: [], blocks: [{ note: 'maintenance' }] }), []);
}));
test('hatch: non-hourly slots are refused, not guessed', async () => {
  await assert.rejects(hatch({ booked: [], slot_minutes: 30 }), /hourly grid/);
});

// okrabook (Beat): detail page (token + court table) then getTimes
const BEAT_SPACES = {
  1: { id: 1, title: 'Indoor Tennis Court 1' }, 2: { id: 2, title: 'Indoor Tennis Court 2' },
  7: { id: 7, title: 'Orange Clay Tennis Court 7 (Kid)' }, 11: { id: 11, title: 'U4 Tennis Room (Kid)' },
  12: { id: 12, title: 'Outdoor Tennis Court 11' }, 50: { id: 50, title: 'Table Tennis  1' },
  14: { id: 14, title: 'Badminton Court 1' },
};
let okraBase = 0;
async function okra(getTimes, { spaces = BEAT_SPACES, statuses = [] } = {}) {
  const base = `https://t${++okraBase}.okrabook.test`; // fresh handshake cache per test
  const page = `<input name="_token" value="tok"><script>var spaces = ${JSON.stringify(spaces)};</script>`;
  let handshakes = 0;
  globalThis.fetch = async (url) => {
    if (url.includes('/venues/detail/')) { handshakes++; return html(page); }
    const st = statuses.shift();
    return st ? json({}, st) : json(getTimes);
  };
  const out = await fetchOkrabook({ base, detailPath: '/venues/detail/X', venueId: 1, sportId: 3 }, '2026-10-03');
  return { out, handshakes };
}

test('okrabook: kids courts and other sports never count (regression: Beat inflated ×7–×9)', async () => {
  const { out } = await okra({ times: { 68400: { spaces: [1, 7, 11, 12, 50, 14] } }, booked_spaces: [] });
  assert.deepEqual(Object.keys(out).sort(), ['Indoor Tennis Court 1', 'Indoor Tennis Court 2', 'Outdoor Tennis Court 11']);
  assert.deepEqual(out['Indoor Tennis Court 1'], [19]);
});
test('okrabook: a fully-booked court stays present so its opening-up can be detected', async () => {
  const { out } = await okra({ times: { 68400: { spaces: [1] } } });
  assert.deepEqual(out['Indoor Tennis Court 2'], []);
});
test('okrabook: labels are the real court names, identical every day (regression)', async () => {
  const a = (await okra({ times: { 25200: { spaces: [2] } } })).out;
  const b = (await okra({ times: { 25200: { spaces: [1, 12] } } })).out;
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
});
test('okrabook: waitlist venues list booked courts in booked_spaces — subtract them', async () => {
  const { out } = await okra({ waitlist_enabled: true, times: { 68400: { spaces: [1, 2] } }, booked_spaces: { 68400: [2] } });
  assert.deepEqual(out['Indoor Tennis Court 1'], [19]);
  assert.deepEqual(out['Indoor Tennis Court 2'], []);
});
test('okrabook: an expired session (419) re-handshakes once', async () => {
  const { out, handshakes } = await okra({ times: { 68400: { spaces: [1] } } }, { statuses: [419] });
  assert.equal(handshakes, 2);
  assert.deepEqual(out['Indoor Tennis Court 1'], [19]);
});
test('okrabook: half-hour start times are refused, not guessed', async () => {
  await assert.rejects(okra({ times: { 68400: { spaces: [1] }, 70200: { spaces: [1] } } }), /not on the hour/);
});

// Reservation System (GOAT57): SvelteKit __data.json in devalue format
function devalue(root) { // encode plain JS into the index-referenced pool the site returns
  const pool = [];
  const enc = (v) => {
    const i = pool.length;
    if (Array.isArray(v)) { pool.push(null); pool[i] = v.map(enc); return i; }
    if (v && typeof v === 'object') { pool.push(null); pool[i] = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])); return i; }
    pool.push(v); return i;
  };
  enc(root);
  return { type: 'data', nodes: [null, { type: 'data', data: [{ user: 1 }, null] }, { type: 'data', data: pool }] };
}
const week = (end = '23:00') => [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, isOpen: true, timeSlots: [{ startTime: '06:00', endTime: end }] }));
async function goat(date, over = {}) {
  const data = {
    date,
    items: [{ id: 'C1', name: 'Court 1', type: 'court' }, { id: 'C2', name: 'Court 2', type: 'court' }],
    bookings: [], holidays: [],
    businessHoursConfig: { defaultSlotDurationMinutes: 60, bufferBetweenBookingsMinutes: 0, weeklySchedule: week() },
    ...over,
  };
  globalThis.fetch = async () => json(devalue(data));
  return fetchReservationSystem({ base: 'https://g.test' }, date);
}

test('goat57: bookings (possibly multi-item) block their courts only', async () => {
  const r = await goat('2026-10-01', { bookings: [{ items: [
    { itemId: 'C1', bookingDate: '2026-10-01', startTime: '18:00', endTime: '19:00' },
    { itemId: 'C1', bookingDate: '2026-10-01', startTime: '19:00', endTime: '20:00' }] }] });
  assert.ok(!r['Court 1'].includes(18) && !r['Court 1'].includes(19) && r['Court 1'].includes(20));
  assert.equal(r['Court 2'].length, 17);
});
test('goat57: 06:00 IS bookable (regression: my test once misread "6:00")', async () => {
  assert.equal((await goat('2026-10-01'))['Court 1'][0], 6);
});
test('goat57: closing 00:00 (Fri/Sat) includes the 23:00 slot', async () => {
  const r = await goat('2026-10-02', { businessHoursConfig: { defaultSlotDurationMinutes: 60, bufferBetweenBookingsMinutes: 0, weeklySchedule: week('00:00') } });
  assert.equal(r['Court 1'].at(-1), 23);
});
test('goat57: holidays — closed, modified hours, deleted, and a closed weekday', async () => {
  assert.deepEqual((await goat('2026-10-01', { holidays: [{ date: '2026-10-01', type: 'closed' }] }))['Court 1'], []);
  assert.deepEqual((await goat('2026-10-01', { holidays: [{ date: '2026-10-01', type: 'modified', modifiedHours: [{ startTime: '10:00', endTime: '12:00' }] }] }))['Court 1'], [10, 11]);
  assert.equal((await goat('2026-10-01', { holidays: [{ date: '2026-10-01', type: 'closed', deletedAt: 'x' }] }))['Court 1'].length, 17);
  const closedThu = week().map((w) => (w.dayOfWeek === 4 ? { ...w, isOpen: false } : w));
  assert.deepEqual((await goat('2026-10-01', { businessHoursConfig: { defaultSlotDurationMinutes: 60, bufferBetweenBookingsMinutes: 0, weeklySchedule: closedThu } }))['Court 1'], []);
});
test('goat57: 90-min slots or buffers are refused, not guessed', async () => {
  await assert.rejects(goat('2026-10-01', { businessHoursConfig: { defaultSlotDurationMinutes: 90, bufferBetweenBookingsMinutes: 0, weeklySchedule: week() } }), /hourly grid/);
});

// Skedda / AllBooked (Ruji): recurring series must be expanded correctly
const series = (rrule, { start = '2025-09-01T07:00:00', end = '2025-09-01T08:00:00', exdate } = {}) => ({
  start, end, spaces: ['T1'],
  recurrenceRule: `DTSTART:${start.replace(/[-:]/g, '')}Z\r\nDTEND:${end.replace(/[-:]/g, '')}Z\r\nRRULE:${rrule}` + (exdate ? `\r\nEXDATE:${exdate}` : ''),
});
// occurrenceStarts also returns the previous day's occurrences (for past-midnight
// bookings); these unit tests look only at occurrences that START on `date`.
const hoursOn = (b, date) => { const day = Date.parse(`${date}T00:00:00Z`) / 60_000;
  return occurrenceStarts(b, date).filter((m) => m >= day).map((m) => (m % 1440) / 60); };

test('skedda: weekly series lands on its weekday only, until its end date', () => {
  const b = series('FREQ=WEEKLY;UNTIL=20261228T235959Z;INTERVAL=1;BYDAY=MO;WKST=MO');
  assert.deepEqual(hoursOn(b, '2026-10-05'), [7]);     // Monday
  assert.deepEqual(hoursOn(b, '2026-10-06'), []);      // Tuesday
  assert.deepEqual(hoursOn(b, '2027-01-04'), []);      // after UNTIL
  assert.deepEqual(hoursOn(b, '2025-08-25'), []);      // before DTSTART
});
test('skedda: EXDATE removes single weeks', () => {
  const b = series('FREQ=WEEKLY;UNTIL=20261228T235959Z;BYDAY=MO', { exdate: '20251006T000000Z,20261005T000000Z' });
  assert.deepEqual(hoursOn(b, '2026-10-05'), []);
  assert.deepEqual(hoursOn(b, '2026-10-12'), [7]);
});
test('skedda: every-2-weeks, several weekdays, daily, and COUNT', () => {
  const bi = series('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=MO');
  assert.deepEqual(hoursOn(bi, '2025-09-03'), [7]);    // week 0 Wed
  assert.deepEqual(hoursOn(bi, '2025-09-08'), []);     // week 1 Mon — skipped
  assert.deepEqual(hoursOn(bi, '2025-09-15'), [7]);    // week 2 Mon
  const daily = series('FREQ=DAILY;INTERVAL=3');
  assert.deepEqual(hoursOn(daily, '2025-09-04'), [7]);
  assert.deepEqual(hoursOn(daily, '2025-09-05'), []);
  const counted = series('FREQ=WEEKLY;COUNT=2;BYDAY=MO');
  assert.deepEqual(hoursOn(counted, '2025-09-08'), [7]);
  assert.deepEqual(hoursOn(counted, '2025-09-15'), []);  // 3rd occurrence — beyond COUNT
});
test('skedda: exotic recurrences are refused, not guessed', () => {
  assert.throws(() => occurrenceStarts(series('FREQ=MONTHLY;BYDAY=1MO'), '2025-10-06'), /unsupported/);
  assert.throws(() => occurrenceStarts(series('FREQ=WEEKLY;BYDAY=MO;BYSETPOS=1'), '2025-10-06'), /unsupported/);
});

async function skedda(bookings, venueOver = {}) {
  const base = `https://s${++okraBase}.allbooked.test`;
  const webs = { venue: [{ timeGranularityMinutes: 60, bufferTime: { rules: [] },
      hoursOfAvailability: { rules: [{ spaceIds: null, start: 300, end: 1440, daysBitmask: 127 }] }, ...venueOver }],
    assets: [{ id: 'T1', name: 'Tennis 1' }, { id: 'T2', name: 'Tennis 2' }, { id: 'P3', name: 'Pickleball 3' }] };
  globalThis.fetch = async (url) => {
    if (url.endsWith('/booking')) return html('<input name="__RequestVerificationToken" RequestVerificationToken" type="hidden" value="tok">');
    if (url.endsWith('/webs')) return json(webs);
    return json({ bookings });
  };
  return fetchSkedda({ base }, '2026-10-05');
}
test('skedda: tennis courts only, 05:00–24:00, one-off + recurring + past-midnight bookings', async () => {
  const r = await skedda([
    { start: '2026-10-05T22:00:00', end: '2026-10-06T00:00:00', spaces: ['T1'] },     // one-off to midnight
    { start: '2026-10-04T23:00:00', end: '2026-10-05T01:00:00', spaces: ['T2'] },     // from the night before
    { ...series('FREQ=WEEKLY;BYDAY=MO'), spaces: ['T2'] },                              // Mondays 07:00
    { start: '2026-10-05T10:00:00', end: '2026-10-05T11:00:00', spaces: ['P3'] },     // pickleball, ignored
  ]);
  assert.deepEqual(Object.keys(r), ['Tennis 1', 'Tennis 2']);
  assert.equal(r['Tennis 1'][0], 5);
  assert.ok(!r['Tennis 1'].includes(22) && !r['Tennis 1'].includes(23) && r['Tennis 1'].includes(21));
  assert.ok(!r['Tennis 2'].includes(7) && r['Tennis 2'].includes(8) && r['Tennis 2'].includes(10));
});
test('skedda: 30-min granularity or buffers are refused, not guessed', async () => {
  await assert.rejects(skedda([], { timeGranularityMinutes: 30 }), /granularity/);
});
