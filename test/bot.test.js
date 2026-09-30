// LINE bot: commands, alert matching + dedupe, webhook security, health, self-check.
// Everything runs offline against a fake LINE client and an in-memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, describeWatch } from '../lib/commands.js';
import { findSlots, runAlerts } from '../lib/alerts.js';
import { openDb } from '../lib/db.js';
import { verifySignature, signBody } from '../lib/line.js';
import { handleWebhook } from '../lib/webhook.js';
import { handleText } from '../lib/bot.js';
import { updateHealth, runSelfCheck, maybeDailySelfCheck, FAILS_TO_ALERT } from '../lib/health.js';

const bkk = (date, h, min = 0) => Date.parse(`${date}T00:00:00Z`) + (h - 7) * 3_600_000 + min * 60_000;
const NOW = bkk('2026-09-29', 14, 5);                  // Tuesday 14:05 Bangkok
const CLOCK = { today: '2026-09-29', hour: 14 };
const T = new Date(NOW).toISOString();                 // "this poll"
const EARLIER = new Date(NOW - 10 * 60_000).toISOString();
const DATES = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];

const CAT = [
  { id: 'goat', name: 'GOAT57', aliases: ['goat', 'โกท'], area: 'Rama 3', areaTh: 'พระราม 3', indoor: true,
    source: { type: 'reservationSystem' }, bookingUrl: 'https://g.test/', bookingUrlForDate: 'https://g.test/?date={date}',
    expectCourts: ['Court 1', 'Court 2'] },
  { id: 'beat', name: 'BEAT Discovery', aliases: ['beat'], area: 'Udomsuk (Sukhumvit 66/1)', areaTh: 'อุดมสุข (สุขุมวิท 66/1)',
    indoor: true, source: { type: 'okrabook' }, bookingUrl: 'https://b.test/' },
  { id: 'ruji', name: 'Rujiseri', aliases: ['ruji'], area: 'Phaya Thai', indoor: false, bookBy: 'admin',
    source: { type: 'skedda' }, bookingUrl: 'https://r.test/' },
  { id: 'ace', name: 'Ace of Clubs', aliases: ['ace'], area: 'Rama IV', indoor: true, source: { type: 'manual' }, bookingUrl: 'https://a.test/' },
  { id: 'crystal', name: 'Crystal Sports', aliases: ['crystal'], area: 'Lat Phrao', indoor: true, source: { type: 'manual' }, bookingUrl: 'https://c.test/' },
  { id: 'crystalg', name: 'Crystal Sports G', aliases: ['crystal g'], area: 'Palm Hills', indoor: true, source: { type: 'manual' }, bookingUrl: 'https://cg.test/' },
  { id: 'simoorgh', name: 'Simoorgh', aliases: ['simoorgh'], area: 'Sukhumvit 56', indoor: false, source: { type: 'manual' }, bookingUrl: 'https://s.test/' },
];
const snapshot = (over = {}) => ({
  generatedAt: T, dates: DATES,
  venues: {
    goat: { live: true, errorDates: [], byDate: { '2026-10-03': { 'Court 1': [18, 19, 20], 'Court 2': [18] } },
      freed: { '2026-10-03': { 'Court 1': { 19: T } } } },
    beat: { live: true, errorDates: [], byDate: { '2026-10-03': { 'Indoor Tennis Court 1': [18, 19], 'Outdoor Tennis Court 11': [18, 19] } },
      freed: { '2026-10-03': { 'Indoor Tennis Court 1': { 18: EARLIER } } } },
    ruji: { live: true, errorDates: [], byDate: {}, freed: {} },
    ...over,
  },
});
const fakeLine = () => ({ dry: false, sent: [], async reply(_t, text, to) { this.sent.push({ kind: 'reply', to, text }); },
  async push(to, text) { this.sent.push({ kind: 'push', to, text }); } });
const quiet = { log() {}, warn() {}, error() {} };
const parse = (t) => parseCommand(t, { catalog: CAT, clock: CLOCK });

// ─── commands ───────────────────────────────────────────────────────────────
test('commands: English and Thai give the same watch', () => {
  const en = parse('alert Sat 18-21 2h goat'), th = parse('แจ้งเตือน เสาร์ 18-21 2ชม โกท');
  for (const w of [en, th]) {
    assert.equal(w.type, 'alert');
    assert.deepEqual([w.dayKind, w.dayValue, w.fromH, w.toH, w.minHours, w.venues], ['date', '2026-10-03', 18, 21, 2, ['goat']]);
  }
  assert.equal(describeWatch(en, CAT), 'Sat 3 Oct · 18:00–21:00 · 2h · GOAT57');
  assert.equal(parse('แจ้งเตือนเสาร์18-21').dayValue, '2026-10-03');          // Thai without spaces
});

test('commands: days, times, places', () => {
  assert.deepEqual([parse('alert every sun evening indoor').dayKind, parse('alert every sun evening indoor').dayValue], ['weekly', '0']);
  assert.equal(parse('alert every sun evening indoor').place, 'indoor');
  assert.deepEqual([parse('alert tomorrow 6-9pm').fromH, parse('alert tomorrow 6-9pm').toH], [18, 21]);
  assert.equal(parse('alert tomorrow 6-9pm').dayValue, '2026-09-30');
  assert.equal(parse('alert 2026-10-03 18-21').fromH, 18);                    // regression: ISO date ≠ time
  assert.equal(parse('alert 3/10 18-21').dayValue, '2026-10-03');
  assert.equal(parse('alert tue 12-14').dayValue, '2026-10-06');              // today's window is over -> next week
  assert.equal(parse('alert today 16-20 2h').dayValue, '2026-09-29');
  assert.equal(parse('alert beat').dayKind, 'any');
});

test('commands: venue aliases, longest wins; "near"; self-check venues', () => {
  assert.deepEqual(parse('alert crystal g sat'), { type: 'error', reason: 'selfcheck-only', venues: ['crystalg'] });
  const near = parse('alert tomorrow near sukhumvit');
  assert.deepEqual(near.venues, ['beat']);
  assert.deepEqual(near.selfCheckNamed, ['simoorgh']);
  assert.equal(parse('alert near nowhere').type, 'error');
  assert.equal(parse('alert this place').venues.length, 0);                   // "place" must not match "ace"
});

test('commands: impossible requests are refused with a reason', () => {
  assert.match(parse('alert sat 18-19 2h').reason, /shorter than 2h/);
  assert.match(parse('alert today 13-15 2h').reason, /too late today/);
  assert.match(parse('alert 9h').reason, /1 to 6 hours/);
  assert.match(parse('alert 25/13').reason, /date/);
  assert.deepEqual(parse('cancel 2'), { type: 'cancel', which: 2 });
  assert.deepEqual(parse('ยกเลิกทั้งหมด'), { type: 'cancel', which: 'all' });
  assert.equal(parse('ดูแจ้งเตือน').type, 'list');
  assert.equal(parse('hello').type, 'help');
  assert.equal(parse('สวัสดีครับ').type, 'help');
  assert.equal(parse('what courts').type, 'unknown');
});

// ─── matching ───────────────────────────────────────────────────────────────
const W = (o = {}) => ({ venues: [], dayKind: 'date', dayValue: '2026-10-03', fromH: 18, toH: 21, minHours: 2, place: 'all', ...o });

test('match: whole runs on one court, inside the window', () => {
  const s = findSlots(W(), snapshot(), CAT, { now: NOW });
  assert.deepEqual(s.map((x) => `${x.venueId} ${x.start}-${x.end} ${x.courts}`),
    ['goat 18-20 Court 1', 'goat 19-21 Court 1', 'beat 18-20 Indoor Tennis Court 1,Outdoor Tennis Court 11']);
});

test('match: onlyNew = a run containing an hour freed IN THIS POLL', () => {
  const s = findSlots(W(), snapshot(), CAT, { now: NOW, onlyNew: true });
  assert.deepEqual(s.map((x) => `${x.venueId} ${x.start}`), ['goat 18', 'goat 19']);   // Beat's stamp is from an earlier poll
});

test('match: place, failed days and past hours are respected', () => {
  assert.deepEqual(findSlots(W({ place: 'outdoor' }), snapshot(), CAT, { now: NOW }).map((x) => x.courts.join()), ['Outdoor Tennis Court 11']);
  const failed = snapshot({ goat: { ...snapshot().venues.goat, errorDates: ['2026-10-03'] } });
  assert.ok(!findSlots(W(), failed, CAT, { now: NOW }).some((x) => x.venueId === 'goat'));
  const today = snapshot({ goat: { live: true, errorDates: [], byDate: { '2026-09-29': { 'Court 1': [13, 14, 15, 16] } } } });
  assert.deepEqual(findSlots(W({ dayValue: '2026-09-29', fromH: 12, toH: 18 }), today, CAT, { now: NOW }).map((x) => x.start), [15]);
});

// ─── alerts ─────────────────────────────────────────────────────────────────
test('alerts: one message per person, each slot only once, overlapping alerts merged', async () => {
  const db = openDb(':memory:'); const line = fakeLine();
  db.addWatch('U1', W());
  db.addWatch('U1', W({ venues: ['goat'] }));        // overlaps the first
  db.addWatch('U2', W({ minHours: 1, fromH: 19, toH: 20 }));
  const r1 = await runAlerts({ db, catalog: CAT, snapshot: snapshot(), line, now: NOW, log: quiet });
  assert.equal(r1.users, 2);
  const u1 = line.sent.filter((m) => m.to === 'U1');
  assert.equal(u1.length, 1);
  assert.match(u1[0].text, /18:00–20:00 · Court 1/);
  assert.match(u1[0].text, /https:\/\/g\.test\/\?date=2026-10-03/);
  assert.equal((u1[0].text.match(/18:00–20:00/g) || []).length, 1);          // merged, not duplicated
  line.sent.length = 0;
  await runAlerts({ db, catalog: CAT, snapshot: snapshot(), line, now: NOW, log: quiet });
  assert.equal(line.sent.length, 0);                                            // same slots: never again
});

test('alerts: a failed push is retried next poll, not lost', async () => {
  const db = openDb(':memory:');
  db.addWatch('U1', W());
  const broken = { async push() { throw new Error('LINE 500'); } };
  assert.equal((await runAlerts({ db, catalog: CAT, snapshot: snapshot(), line: broken, now: NOW, log: quiet })).users, 0);
  const line = fakeLine();
  assert.equal((await runAlerts({ db, catalog: CAT, snapshot: snapshot(), line, now: NOW, log: quiet })).users, 1);
});

test('alerts: one-off alerts for past days expire', async () => {
  const db = openDb(':memory:');
  db.addWatch('U1', W({ dayValue: '2026-09-28' }));
  await runAlerts({ db, catalog: CAT, snapshot: snapshot(), line: fakeLine(), now: NOW, log: quiet });
  assert.equal(db.activeWatches().length, 0);
});

// ─── bot replies ────────────────────────────────────────────────────────────
test('bot: setting an alert also shows what is free right now', async () => {
  const db = openDb(':memory:');
  const reply = await handleText({ userId: 'U1', text: 'alert sat 18-21 2h goat', db, catalog: CAT, snapshot: snapshot(), now: NOW });
  assert.match(reply, /Alert 1 set/);
  assert.match(reply, /Free right now/);
  assert.match(reply, /18:00–20:00 · Court 1/);
  assert.match(await handleText({ userId: 'U1', text: 'my alerts', db, catalog: CAT, snapshot: snapshot(), now: NOW }), /1\. Sat 3 Oct/);
  assert.match(await handleText({ userId: 'U1', text: 'cancel 1', db, catalog: CAT, snapshot: snapshot(), now: NOW }), /Cancelled alert 1/);
  assert.match(await handleText({ userId: 'U1', text: 'alert ace', db, catalog: CAT, snapshot: snapshot(), now: NOW }), /can't watch Ace of Clubs/);
});

test('bot: admin-only commands are hidden from everyone else', async () => {
  const db = openDb(':memory:');
  db.touchUser('Uguest');
  assert.doesNotMatch(await handleText({ userId: 'Uguest', text: 'status', db, catalog: CAT, snapshot: snapshot(), now: NOW }), /Checking status/);
  db.setAdmin('Uadmin');
  assert.match(await handleText({ userId: 'Uadmin', text: 'status', db, catalog: CAT, snapshot: snapshot(), now: NOW }), /Checking status/);
});

// ─── webhook security ───────────────────────────────────────────────────────
test('line: signature must match the raw body exactly', () => {
  const body = Buffer.from('{"events":[]}');
  const sig = signBody('s3cret', body);
  assert.equal(verifySignature('s3cret', body, sig), true);
  assert.equal(verifySignature('wrong', body, sig), false);
  assert.equal(verifySignature('s3cret', Buffer.from('{"events":[] }'), sig), false);  // one byte changed
  assert.equal(verifySignature('s3cret', body, undefined), false);
});

test('webhook: unsigned or unconfigured requests are rejected; follow makes the first user admin', async () => {
  const db = openDb(':memory:'); const line = fakeLine();
  const ev = (events) => Buffer.from(JSON.stringify({ events }));
  const call = (raw, sig, secret = 'sec') => handleWebhook({ rawBody: raw, signature: sig, secret, db, line, catalog: CAT, snapshot: () => snapshot(), now: NOW, log: quiet });
  assert.equal((await call(ev([]), 'x', '')).status, 503);
  assert.equal((await call(ev([]), 'forged')).status, 401);
  assert.equal((await call(ev([]), signBody('sec', ev([])))).status, 200);          // LINE's "Verify" button
  const follow = ev([{ type: 'follow', replyToken: 'r', source: { userId: 'Ume' } }]);
  assert.equal((await call(follow, signBody('sec', follow))).status, 200);
  assert.deepEqual(db.admins(), ['Ume']);
  assert.match(line.sent[0].text, /You’re the admin/);
  const msg = ev([{ type: 'message', replyToken: 'r2', source: { userId: 'Ufriend' }, message: { type: 'text', text: 'alert sat 18-21 2h' } }]);
  await call(msg, signBody('sec', msg));
  assert.deepEqual(db.admins(), ['Ume']);                                            // only the first
  assert.match(line.sent.at(-1).text, /Alert 1 set/);
});

// ─── health ─────────────────────────────────────────────────────────────────
test('health: 3 failed polls -> one warning, no repeats, one recovery message', async () => {
  const db = openDb(':memory:'); const line = fakeLine(); db.setAdmin('Uadmin');
  const failing = snapshot({ goat: { live: true, errorDates: ['2026-10-03'], errors: ['2026-10-03: HTTP 500'], byDate: {} } });
  for (let i = 1; i <= FAILS_TO_ALERT + 1; i++) await updateHealth({ db, catalog: CAT, snapshot: failing, line, log: quiet });
  const warnings = line.sent.filter((m) => /GOAT57: checking has failed/.test(m.text));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].text, /HTTP 500/);
  await updateHealth({ db, catalog: CAT, snapshot: snapshot(), line, log: quiet });
  await updateHealth({ db, catalog: CAT, snapshot: snapshot(), line, log: quiet });
  assert.equal(line.sent.filter((m) => /GOAT57: checking is working again/.test(m.text)).length, 1);
});

test('health: a changed court list is reported (the quiet failure), first sighting is silent', async () => {
  const db = openDb(':memory:'); const line = fakeLine(); db.setAdmin('Uadmin');
  await updateHealth({ db, catalog: CAT, snapshot: snapshot(), line, log: quiet });
  assert.equal(line.sent.length, 0);
  const kidsSlipIn = snapshot({ beat: { live: true, errorDates: [], byDate: { '2026-10-03': {
    'Indoor Tennis Court 1': [], 'Outdoor Tennis Court 11': [], 'Orange Clay Tennis Court 7 (Kid)': [9] } } } });
  await updateHealth({ db, catalog: CAT, snapshot: kidsSlipIn, line, log: quiet });
  assert.match(line.sent[0].text, /BEAT Discovery: its court list changed[\s\S]*New: Orange Clay Tennis Court 7 \(Kid\)/);
});

// ─── daily self-check ───────────────────────────────────────────────────────
test('self-check: flags unexpected courts (the Beat kids bug), missing courts and failures', async () => {
  const cat = [CAT[0]];
  const ok = await runSelfCheck({ catalog: cat, adapters: { reservationSystem: async () => ({ 'Court 1': [9], 'Court 2': [] }) }, now: NOW });
  assert.deepEqual(ok.problems, []);
  const kids = await runSelfCheck({ catalog: cat, adapters: { reservationSystem: async () => ({ 'Court 1': [], 'Court 2': [], 'Kids 1': [] }) }, now: NOW });
  assert.match(kids.problems[0], /unexpected courts Kids 1/);
  const gone = await runSelfCheck({ catalog: cat, adapters: { reservationSystem: async () => ({ 'Court 1': [] }) }, now: NOW });
  assert.match(gone.problems[0], /missing courts Court 2/);
  const down = await runSelfCheck({ catalog: cat, adapters: { reservationSystem: async () => { throw new Error('boom'); } }, now: NOW });
  assert.match(down.problems[0], /check failed — boom/);
});

test('self-check: runs once a day after 09:00 and only messages when something is wrong', async () => {
  const db = openDb(':memory:'); const line = fakeLine(); db.setAdmin('Uadmin');
  const adapters = { reservationSystem: async () => ({ 'Court 1': [] }) };
  assert.equal(await maybeDailySelfCheck({ db, catalog: [CAT[0]], adapters, line, now: bkk('2026-09-29', 8), log: quiet }), null);
  await maybeDailySelfCheck({ db, catalog: [CAT[0]], adapters, line, now: bkk('2026-09-29', 9, 30), log: quiet });
  await maybeDailySelfCheck({ db, catalog: [CAT[0]], adapters, line, now: bkk('2026-09-29', 11), log: quiet });
  assert.equal(line.sent.length, 1);
  assert.match(line.sent[0].text, /missing courts Court 2/);
});

test('bot: "nothing free" explains near-misses — single hours that are not back-to-back (Hatch 30 Sep case)', async () => {
  const db = openDb(':memory:');
  const snap = snapshot({ goat: { live: true, errorDates: [], byDate: { '2026-09-30': { 'Court 1': [], 'Court 3': [7, 9] } } } });
  const r = await handleText({ userId: 'U1', text: 'alert 30/9 7-12 2h goat', db, catalog: CAT, snapshot: snap, now: NOW });
  assert.match(r, /Nothing free for 2h in a row right now \(same court\)/);
  assert.match(r, /07:00–08:00 · Court 3/);
  assert.match(r, /09:00–10:00 · Court 3/);
  const one = await handleText({ userId: 'U1', text: 'alert 30/9 7-12 1h goat', db, catalog: CAT, snapshot: snap, now: NOW });
  assert.match(one, /Free right now/);
});
