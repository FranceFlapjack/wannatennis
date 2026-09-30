// Watches -> slots. Used twice:
//   - when someone sets an alert: "what's free right now?"        (onlyNew: false)
//   - after every poll: "what just opened up?" -> LINE push        (onlyNew: true)
// A run is "new" if ANY of its hours freed up in THIS poll: wanting 18–20, with 18
// already free, the 19:00 cancellation is what makes the 2-hour game possible.
import { courtIsIndoor, dropPastHours, bkkClock } from './state.js';
import { fmtDate, hh, dowOf } from './commands.js';

const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });
const isLive = (v) => v.source?.type && v.source.type !== 'manual';
// "Indoor Tennis Court 1" -> "Indoor 1", "Tennis 2" -> "Court 2", "Court 3" stays
export const shortCourt = (n) => {
  const t = n.replace(/\s*tennis\s*/i, ' ').replace(/\bcourt\s+/i, '').replace(/\s+/g, ' ').trim();
  return /^\d+$/.test(t) ? `Court ${t}` : t;
};

export function watchDates(w, snapshot, today) {
  const dates = snapshot.dates.filter((d) => d >= today);
  if (w.dayKind === 'date') return dates.filter((d) => d === w.dayValue);
  if (w.dayKind === 'weekly') return dates.filter((d) => dowOf(d) === Number(w.dayValue));
  return dates;
}

function stampedAt(freedForDate, iso) {
  const set = new Set();
  for (const [court, hours] of Object.entries(freedForDate || {})) {
    for (const [h, t] of Object.entries(hours)) if (t === iso) set.add(`${court}:${h}`);
  }
  return set;
}

/** [{ venueId, date, start, end, courts[] }] — courts free for the whole run inside the window. */
export function findSlots(w, snapshot, catalog, { now = Date.now(), onlyNew = false } = {}) {
  const clock = bkkClock(now);
  const venues = catalog.filter((v) => isLive(v) && (!w.venues.length || w.venues.includes(v.id)));
  const out = [];
  for (const v of venues) {
    const info = snapshot.venues[v.id];
    if (!info?.live) continue;
    for (const date of watchDates(w, snapshot, clock.today)) {
      if (info.errorDates?.includes(date)) continue;               // never alert from a failed check
      const free = dropPastHours(info.byDate?.[date] || {}, date, clock);
      const fresh = onlyNew ? stampedAt(info.freed?.[date], snapshot.generatedAt) : null;
      const byStart = new Map();
      for (const [court, hours] of Object.entries(free)) {
        if (w.place !== 'all' && courtIsIndoor(court, v) !== (w.place === 'indoor')) continue;
        const set = new Set(hours);
        for (let s = w.fromH; s + w.minHours <= w.toH; s++) {
          let whole = true, isNew = false;
          for (let k = 0; k < w.minHours; k++) {
            if (!set.has(s + k)) { whole = false; break; }
            if (fresh?.has(`${court}:${s + k}`)) isNew = true;
          }
          if (!whole || (onlyNew && !isNew)) continue;
          if (!byStart.has(s)) byStart.set(s, []);
          byStart.get(s).push(court);
        }
      }
      for (const [start, courts] of [...byStart].sort((a, b) => a[0] - b[0])) {
        out.push({ venueId: v.id, date, start, end: start + w.minHours, courts: courts.sort(natural) });
      }
    }
  }
  return out;
}

/** Human text for a list of slots, grouped by day then venue, with booking links. */
export function formatSlots(slots, catalog, { max = 14 } = {}) {
  const lines = [];
  let shown = 0;
  const byDate = new Map();
  for (const s of slots) { if (!byDate.has(s.date)) byDate.set(s.date, []); byDate.get(s.date).push(s); }
  for (const [date, list] of [...byDate].sort()) {
    if (shown >= max) break;
    lines.push(`📅 ${fmtDate(date)}`);
    const byVenue = new Map();
    for (const s of list) { if (!byVenue.has(s.venueId)) byVenue.set(s.venueId, []); byVenue.get(s.venueId).push(s); }
    for (const [venueId, vs] of byVenue) {
      const v = catalog.find((x) => x.id === venueId);
      lines.push(`• ${v?.name ?? venueId}${v?.bookBy === 'admin' ? ' (book via admin)' : ''}`);
      for (const s of vs) {
        if (shown >= max) break;
        lines.push(`   ${hh(s.start)}–${hh(s.end)} · ${s.courts.map(shortCourt).join(', ')}`);
        shown++;
      }
      const url = v?.bookingUrlForDate ? v.bookingUrlForDate.replace('{date}', date) : v?.bookingUrl;
      if (url) lines.push(`   ${url}`);
    }
    lines.push('');
  }
  if (slots.length > shown) lines.push(`…and ${slots.length - shown} more on the website.`);
  return lines.join('\n').trim();
}

/**
 * After a poll: push each person the slots that just opened for their alerts.
 * One message per person per poll; each (venue, court, day, start) at most once ever.
 */
export async function runAlerts({ db, catalog, snapshot, line, now = Date.now(), log = console, quick = null }) {
  const { today } = bkkClock(now);
  db.expireBefore(today);
  db.pruneSentBefore(today);
  const perUser = new Map();
  for (const w of db.activeWatches()) {
    for (const s of findSlots(w, snapshot, catalog, { now, onlyNew: true })) {
      const courts = s.courts.filter((c) => !db.wasSent(w.userId, s.venueId, c, s.date, s.start));
      if (!courts.length) continue;
      if (!perUser.has(w.userId)) perUser.set(w.userId, new Map());
      const key = `${s.venueId}|${s.date}|${s.start}|${s.end}`;   // two alerts can overlap: merge
      const m = perUser.get(w.userId);
      m.set(key, { ...s, courts: [...new Set([...(m.get(key)?.courts || []), ...courts])].sort(natural) });
    }
  }
  let sent = 0;
  for (const [userId, m] of perUser) {
    const slots = [...m.values()];
    const text = `🔔 A court just opened up!\n\n${formatSlots(slots, catalog)}\n\nBe quick — it may go again.`;
    try {
      await line.push(userId, text, quick);
      for (const s of slots) for (const c of s.courts) db.markSent(userId, s.venueId, c, s.date, s.start);
      sent++;
    } catch (e) {
      log.error(`alerts: push to ${userId} failed — ${e.message}`);   // not marked: retried next poll
    }
  }
  return { users: sent, slots: [...perUser.values()].reduce((a, m) => a + m.size, 0) };
}
