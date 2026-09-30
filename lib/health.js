// Self-monitoring, so a broken venue can never silently look like "no free courts".
//   updateHealth  — after every poll: 3 failed polls in a row -> ONE warning to the admin,
//                   then ONE "working again" when it recovers. Also the quiet failure: a
//                   venue that suddenly returns a different court list (or none) with no error.
//   runSelfCheck  — daily: each live venue must return exactly the courts we verified
//                   against its own booking page (catalog `expectCourts`). This is the check
//                   that would have caught the Beat kids'-court bug on day one.
import { bkkClock } from './state.js';
import { addDays } from './commands.js';

export const FAILS_TO_ALERT = 3;
const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });
const isLive = (v) => v.source?.type && v.source.type !== 'manual';
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

async function tellAdmins(db, line, text, log) {
  const admins = db.admins();
  if (!admins.length) { log.warn(`[no admin yet] ${text}`); return; }
  for (const id of admins) {
    try { await line.push(id, text); } catch (e) { log.error(`health: push to admin failed — ${e.message}`); }
  }
}

export async function updateHealth({ db, catalog, snapshot, line, log = console }) {
  const notes = [];
  for (const v of catalog.filter(isLive)) {
    const info = snapshot.venues[v.id];
    if (!info) continue;
    const h = db.health(v.id);
    if ((info.errorDates || []).length) {
      h.fails += 1;
      h.last_error = info.errors?.[0] || 'unknown error';
      if (h.fails >= FAILS_TO_ALERT && !h.alerted) {
        notes.push(`⚠️ ${v.name}: checking has failed ${h.fails} times in a row (about ${h.fails * 5} min).\n`
          + `Last error: ${h.last_error}\nThe website shows "Couldn't check" for it meanwhile.`);
        h.alerted = 1;
      }
    } else {
      if (h.alerted) notes.push(`✅ ${v.name}: checking is working again.`);
      h.fails = 0; h.alerted = 0; h.last_ok = snapshot.generatedAt;
      const courts = [...new Set(Object.values(info.byDate || {}).flatMap((bc) => Object.keys(bc || {})))].sort(natural);
      if (h.courts && !sameList(h.courts, courts)) {
        const added = courts.filter((c) => !h.courts.includes(c)), removed = h.courts.filter((c) => !courts.includes(c));
        notes.push(courts.length
          ? `ℹ️ ${v.name}: its court list changed.${added.length ? `\nNew: ${added.join(', ')}` : ''}${removed.length ? `\nGone: ${removed.join(', ')}` : ''}\n`
            + 'If these aren\'t normal courts (kids, other sports), the filter needs updating.'
          : `⚠️ ${v.name} now returns NO courts, with no error — their site probably changed.`);
      }
      h.courts = courts;
    }
    db.saveHealth(h);
  }
  if (notes.length) await tellAdmins(db, line, notes.join('\n\n'), log);
  return notes;
}

/** Problems found (empty = all good). Checks tomorrow, a normal full day. */
export async function runSelfCheck({ catalog, adapters, now = Date.now() }) {
  const date = addDays(bkkClock(now).today, 1);
  const problems = [];
  for (const v of catalog.filter((x) => isLive(x) && x.expectCourts)) {
    try {
      const out = await adapters[v.source.type](v.source, date);
      const got = Object.keys(out).sort(natural), want = [...v.expectCourts].sort(natural);
      const extra = got.filter((c) => !want.includes(c)), missing = want.filter((c) => !got.includes(c));
      if (extra.length) problems.push(`${v.name}: unexpected courts ${extra.join(', ')} (kids/other sports slipping in?)`);
      if (missing.length) problems.push(`${v.name}: missing courts ${missing.join(', ')}`);
      for (const [court, hours] of Object.entries(out)) {
        if (!hours.every((h, i) => Number.isInteger(h) && h >= 0 && h <= 23 && (i === 0 || h > hours[i - 1]))) {
          problems.push(`${v.name}: ${court} has malformed hours ${JSON.stringify(hours)}`);
        }
      }
    } catch (e) {
      problems.push(`${v.name}: check failed — ${e.message}`);
    }
  }
  return { date, problems };
}

/** Run once a day from 09:00 Bangkok; only message the admin when something's wrong. */
export async function maybeDailySelfCheck({ db, catalog, adapters, line, now = Date.now(), log = console }) {
  const { today, hour } = bkkClock(now);
  if (hour < 9 || db.get('selfcheck:last') === today) return null;
  db.set('selfcheck:last', today);
  const r = await runSelfCheck({ catalog, adapters, now });
  if (r.problems.length) await tellAdmins(db, line, `🔍 Daily self-check found problems:\n• ${r.problems.join('\n• ')}`, log);
  else log.log(`self-check ${today}: all venues OK`);
  return r;
}
