// Adapter: Skedda / AllBooked (<slug>.skedda.com redirects to <slug>.allbooked.com).
// The public booking calendar needs an ASP.NET anti-forgery pair, exactly like the page:
//   GET  /booking                      -> cookie X-Skedda-RequestVerificationCookie
//                                         + hidden input RequestVerificationToken
//   GET  /webs                         -> venue config + assets (courts)
//   GET  /bookingslists?start=&end=    -> bookings; RECURRING ones come back as a series
//                                         (DTSTART/RRULE/EXDATE) that we must expand.
// All times are the venue's local wall-clock (Asia/Bangkok), even where the RRULE text
// carries a trailing "Z" — the series' DTSTART always equals its local `start` field.
// Unsupported recurrence shapes throw -> the app shows "couldn't check", never a guess.
const UA = 'tennis-finder/0.1 (personal court-finder; contact via app)';
const DEFAULT_EXCLUDE = /\(kids?\)|\bkids?\b|\bu\d{1,2}\b|junior|mini/i;
const HANDSHAKE_TTL_MS = 10 * 60 * 1000;
const sessions = new Map(); // base -> { at, headers, webs }

async function session(base, { force = false } = {}) {
  const cached = sessions.get(base);
  if (!force && cached && Date.now() - cached.at < HANDSHAKE_TTL_MS) return cached;
  const page = await fetch(`${base}/booking`, { headers: { 'User-Agent': UA } });
  if (!page.ok) throw new Error(`skedda booking page ${page.status}`);
  const html = await page.text();
  const token = html.match(/RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/)?.[1];
  if (!token) throw new Error('skedda: no RequestVerificationToken on booking page');
  const cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const headers = { 'User-Agent': UA, Accept: 'application/json', Cookie: cookie, 'X-Skedda-RequestVerificationToken': token };
  const w = await fetch(`${base}/webs`, { headers });
  if (!w.ok) throw new Error(`skedda /webs ${w.status}`);
  const s = { at: Date.now(), headers, webs: await w.json() };
  sessions.set(base, s);
  return s;
}

// Local wall-clock <-> "minutes since epoch" treating local as UTC (Bangkok has no DST).
const localMin = (s) => Date.parse(s.length === 19 ? `${s}Z` : s) / 60_000;       // 'YYYY-MM-DDTHH:MM:SS'
const ymd = (s) => s.replace(/[-]/g, '').slice(0, 8);                              // -> 'YYYYMMDD'
const dayIndex = (yyyymmdd) => Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)) / 86_400_000;
const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/**
 * Local start-minutes of every occurrence of `booking` that starts on day `d` or `d-1`
 * (the day before matters for occurrences that run past midnight). Exported for tests.
 */
export function occurrenceStarts(booking, dateStr) {
  const startMin = localMin(booking.start);
  if (!booking.recurrenceRule) return [startMin];

  const rule = Object.fromEntries(booking.recurrenceRule.split(/\r?\n/).filter(Boolean).map((l) => {
    const i = l.indexOf(':'); return [l.slice(0, i), l.slice(i + 1)];
  }));
  const rr = Object.fromEntries((rule.RRULE || '').split(';').filter(Boolean).map((p) => p.split('=')));
  const freq = rr.FREQ;
  const known = new Set(['FREQ', 'INTERVAL', 'UNTIL', 'COUNT', 'BYDAY', 'WKST']);
  const unknown = Object.keys(rr).filter((k) => !known.has(k));
  if (!['WEEKLY', 'DAILY'].includes(freq) || unknown.length || (rr.BYDAY && /\d/.test(rr.BYDAY))) {
    throw new Error(`skedda: unsupported recurrence ${rule.RRULE}`);
  }
  const interval = Number(rr.INTERVAL || 1);
  const firstDay = dayIndex(ymd(booking.start));
  const timeOfDay = startMin - firstDay * 1440;
  const untilDay = rr.UNTIL ? dayIndex(rr.UNTIL.slice(0, 8)) : Infinity;
  const lastDay = booking.endOfLastOccurrence ? dayIndex(ymd(booking.endOfLastOccurrence)) : Infinity;
  const exdates = new Set((rule.EXDATE || '').split(',').filter(Boolean).map((x) => dayIndex(x.slice(0, 8))));
  const days = rr.BYDAY ? rr.BYDAY.split(',').map((d) => BYDAY[d]) : [new Date(firstDay * 86_400_000).getUTCDay()];
  const weekStart = (di) => di - ((new Date(di * 86_400_000).getUTCDay() + 6) % 7);  // Monday (WKST=MO)

  const occursOn = (di) => {
    if (di < firstDay || di > untilDay || di > lastDay || exdates.has(di)) return false;
    if (freq === 'DAILY') return (di - firstDay) % interval === 0;
    if (!days.includes(new Date(di * 86_400_000).getUTCDay())) return false;
    return ((weekStart(di) - weekStart(firstDay)) / 7) % interval === 0;
  };
  const target = dayIndex(ymd(dateStr));
  let candidates = [target - 1, target].filter(occursOn);
  if (rr.COUNT) {                                   // keep only the first COUNT occurrences
    let n = 0; const limit = Number(rr.COUNT);
    const within = new Set();
    for (let di = firstDay; di <= target && n < limit; di++) if (occursOn(di)) { n++; within.add(di); }
    candidates = candidates.filter((di) => within.has(di));
  }
  return candidates.map((di) => di * 1440 + timeOfDay);
}

/** @returns {Promise<Record<string, number[]>>} court name -> sorted free hours */
export async function fetchSkedda(source, date) {
  let s = await session(source.base);
  const q = `start=${date}T00%3A00%3A00&end=${date}T23%3A59%3A59.999`;
  let res = await fetch(`${source.base}/bookingslists?${q}`, { headers: s.headers });
  if ([401, 419, 422].includes(res.status)) {                 // cookie/token expired: redo once
    s = await session(source.base, { force: true });
    res = await fetch(`${source.base}/bookingslists?${q}`, { headers: s.headers });
  }
  if (!res.ok) throw new Error(`skedda bookingslists ${res.status}`);
  const { bookings = [] } = await res.json();

  const venue = s.webs.venue?.[0] ?? s.webs.venue ?? {};
  if ((venue.timeGranularityMinutes ?? 60) !== 60 || (venue.bufferTime?.rules || []).length) {
    throw new Error('skedda: non-hourly granularity or buffer rules — hourly grid would be wrong');
  }
  const include = source.includeCourts ? new RegExp(source.includeCourts, 'i') : /tennis/i;
  const exclude = source.excludeCourts ? new RegExp(source.excludeCourts, 'i') : DEFAULT_EXCLUDE;
  const courts = (s.webs.assets || []).filter((a) => !a.archived && include.test(a.name) && !exclude.test(a.name));

  // Opening hours: rules in minutes-of-day, per weekday bitmask (.NET DayOfWeek: bit 0 = Sunday).
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const dayStart = dayIndex(ymd(date)) * 1440;

  const out = {};
  for (const c of courts) {
    const open = new Set();
    for (const r of venue.hoursOfAvailability?.rules || []) {
      if (r.spaceIds && !r.spaceIds.map(String).includes(String(c.id))) continue;
      if (!((r.daysBitmask ?? 127) & (1 << dow))) continue;
      for (let t = r.start; t + 60 <= r.end; t += 60) open.add(t / 60);
    }
    const busy = [];
    for (const b of bookings) {
      if (!(b.spaces || []).map(String).includes(String(c.id))) continue;
      const len = localMin(b.end) - localMin(b.start);
      for (const st of occurrenceStarts(b, date)) busy.push([st, st + len]);
    }
    out[c.name.trim()] = [...open].sort((a, b) => a - b).filter((h) => {
      const hs = dayStart + h * 60, he = hs + 60;
      return !busy.some(([s0, e0]) => s0 < he && e0 > hs);
    });
  }
  return out;
}
