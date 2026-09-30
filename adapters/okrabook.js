// Adapter: okrabook — a multi-tenant Thai sports-booking platform (<slug>.okrabook.com).
// The public detail page hands out a session cookie + CSRF token, and embeds the venue's
// court table as `var spaces = { "<id>": { id, title, surface }, ... }`. Then:
//   POST /venues/getTimes  body: id, sport_id, date
//   -> { times: { <secondsFromMidnight>: { title, spaces:[courtId,...] } },
//        booked_spaces: { <secondsFromMidnight>: [courtId,...] }, waitlist_enabled }
//
// How the venue's own page reads this (ven_assets/js/app.js showSpaces):
//   - a court is only shown if it exists in the `spaces` table
//   - with waitlist OFF, `times[t].spaces` are the free courts
//   - with waitlist ON, `times[t].spaces` includes booked ones, listed in booked_spaces[t]
// We mirror that exactly, then drop kids' courts (the "Tennis" sport includes them).
const UA = 'tennis-finder/0.1 (personal court-finder; contact via app)';

// Courts that aren't normal adult courts: "(Kid)", "U4 Tennis Room", junior/mini courts.
const DEFAULT_EXCLUDE = /\(kids?\)|\bkids?\b|\bu\d{1,2}\b|junior|mini/i;

const HANDSHAKE_TTL_MS = 10 * 60 * 1000;
const handshakes = new Map(); // base+path -> { at, cookie, token, spaces }

/** Fetch the detail page once per TTL: session cookie, CSRF token, court table. */
async function handshake(source, { force = false } = {}) {
  const key = source.base + source.detailPath;
  const cached = handshakes.get(key);
  if (!force && cached && Date.now() - cached.at < HANDSHAKE_TTL_MS) return cached;

  const res = await fetch(`${source.base}${source.detailPath}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`okrabook detail ${res.status}`);
  const html = await res.text();
  const token = html.match(/name="_token"\s+value="([^"]+)"/)?.[1]
             || html.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1];
  if (!token) throw new Error('okrabook: no CSRF token on detail page');
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
  const cookie = raw.map((c) => c.split(';')[0]).join('; ');
  const spacesJson = html.match(/var\s+spaces\s*=\s*(\{.*?\});/s)?.[1];
  if (!spacesJson) throw new Error('okrabook: no court table (var spaces) on detail page');
  const spaces = JSON.parse(spacesJson);

  const hs = { at: Date.now(), cookie, token, spaces };
  handshakes.set(key, hs);
  return hs;
}

async function getTimes(source, date, hs) {
  return fetch(`${source.base}/venues/getTimes`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-TOKEN': hs.token,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: hs.cookie,
    },
    body: new URLSearchParams({ id: String(source.venueId), sport_id: String(source.sportId), date }),
  });
}

/** @returns {Promise<Record<string, number[]>>} real court title -> sorted free hours */
export async function fetchOkrabook(source, date) {
  let hs = await handshake(source);
  let res = await getTimes(source, date, hs);
  if (res.status === 419 || res.status === 401) {       // session/CSRF expired: redo once
    hs = await handshake(source, { force: true });
    res = await getTimes(source, date, hs);
  }
  if (!res.ok) throw new Error(`okrabook getTimes ${res.status}`);
  const data = await res.json();

  const exclude = source.excludeCourts ? new RegExp(source.excludeCourts, 'i') : DEFAULT_EXCLUDE;
  const include = source.includeCourts ? new RegExp(source.includeCourts, 'i') : /tennis court/i;
  const booked = data.booked_spaces && !Array.isArray(data.booked_spaces) ? data.booked_spaces : {};

  // Which courts count is decided by NAME from the venue's court table, not by what came
  // back free — otherwise a fully-booked court would vanish for the day and we'd have no
  // baseline to notice when it opens up (the most valuable alert there is).
  // The table spans every sport, so match e.g. "Indoor Tennis Court 3", never "Table Tennis 1".
  let courts = Object.values(hs.spaces).filter((s) => include.test(s.title) && !exclude.test(s.title));
  if (!courts.length) {
    // Venue doesn't name its courts "...Tennis Court...": fall back to what this sport returned.
    const offered = new Set();
    for (const slot of Object.values(data.times || {})) for (const id of slot.spaces || []) offered.add(id);
    courts = [...offered].map((id) => hs.spaces[id]).filter((s) => s && !exclude.test(s.title));
  }

  const byId = new Map(courts.map((s) => [s.id, s.title.trim()]));
  const out = Object.fromEntries([...byId.values()].map((label) => [label, []]));

  const offGrid = Object.keys(data.times || {}).filter((sec) => Number(sec) % 3600 !== 0);
  if (offGrid.length) throw new Error(`okrabook: start times not on the hour (${offGrid.length}) — hourly grid can't represent them`);

  for (const [sec, slot] of Object.entries(data.times || {})) {
    const hour = Number(sec) / 3600;
    const bookedHere = new Set(booked[sec] || []);
    for (const id of slot.spaces || []) {
      if (bookedHere.has(id) || !byId.has(id)) continue;   // booked (waitlist venues) / kids / other sport
      out[byId.get(id)].push(hour);
    }
  }

  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort((a, b) => a - b);
  return out;
}
