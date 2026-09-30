// LINE groups + website alert management (link codes, tokens, same rules as chat).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.js';
import { signBody } from '../lib/line.js';
import { handleWebhook, chatOf, stripSelfMention } from '../lib/webhook.js';
import { handleApi, createLimiter } from '../lib/webapi.js';
import { runAlerts } from '../lib/alerts.js';
import { parseCommand } from '../lib/commands.js';

const bkk = (date, h) => Date.parse(`${date}T00:00:00Z`) + (h - 7) * 3_600_000;
const NOW = bkk('2026-09-29', 14);
const T = new Date(NOW).toISOString();
const CAT = [
  { id: 'goat', name: 'GOAT57', aliases: ['goat'], area: 'Rama 3', indoor: true, source: { type: 'reservationSystem' },
    bookingUrl: 'https://g.test/', bookingUrlForDate: 'https://g.test/?date={date}' },
  { id: 'ace', name: 'Ace of Clubs', aliases: ['ace'], area: 'Rama IV', indoor: true, source: { type: 'manual' }, bookingUrl: 'https://a.test/' },
];
const SNAP = { generatedAt: T, dates: ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'],
  venues: { goat: { live: true, errorDates: [], byDate: { '2026-10-03': { 'Court 1': [18, 19, 20] } }, freed: { '2026-10-03': { 'Court 1': { 19: T } } } } } };
const quiet = { log() {}, warn() {}, error() {} };
const fakeLine = () => ({ sent: [], async reply(_t, text, to) { this.sent.push({ kind: 'reply', to, text }); },
  async push(to, text) { this.sent.push({ kind: 'push', to, text }); }, groupName: async () => 'Tuesday Tennis', displayName: async () => 'Me' });
const G = { type: 'group', groupId: 'Cgroup1', userId: 'Ualice' };

function hook(db, line) {
  return async (events, destination = 'Ubot') => {
    const raw = Buffer.from(JSON.stringify({ destination, events }));
    return handleWebhook({ rawBody: raw, signature: signBody('sec', raw), secret: 'sec', db, line, catalog: CAT, snapshot: () => SNAP, now: NOW, log: quiet });
  };
}
const msg = (text, source = G, mention) => ({ type: 'message', replyToken: 'r', source, message: { type: 'text', text, ...(mention ? { mention } : {}) } });

// ─── groups ─────────────────────────────────────────────────────────────────
test('groups: which chat an event belongs to', () => {
  assert.deepEqual(chatOf({ type: 'user', userId: 'U1' }), { targetId: 'U1', senderId: 'U1', inGroup: false });
  assert.deepEqual(chatOf(G), { targetId: 'Cgroup1', senderId: 'Ualice', inGroup: true });
  assert.deepEqual(chatOf({ type: 'room', roomId: 'Rx' }), { targetId: 'Rx', senderId: null, inGroup: true });
});

test('groups: @mention of the bot is removed and counts as addressing it', () => {
  const r = stripSelfMention({ text: '@Wanna Tennis ? alert sat 18-21', mention: { mentionees: [{ index: 0, length: 15, isSelf: true }] } });
  assert.deepEqual(r, { text: 'alert sat 18-21', addressed: true });
  const other = stripSelfMention({ text: '@Bob alert me', mention: { mentionees: [{ index: 0, length: 4, userId: 'Ubob' }] } }, 'Ubot');
  assert.equal(other.addressed, false);
});

test('groups: the bot stays quiet during normal chat', async () => {
  const db = openDb(':memory:'), line = fakeLine(), send = hook(db, line);
  await send([msg('hi everyone'), msg('lol see you at 7'), msg('ยกเลิก'), msg('cancel'), msg('status')]);
  assert.equal(line.sent.length, 0);
  assert.equal(parseCommand('ยกเลิก 2', { catalog: CAT, clock: { today: '2026-09-29', hour: 14 }, inGroup: true }).type, 'cancel');
});

test('groups: introduces itself on join; @mention gets help', async () => {
  const db = openDb(':memory:'), line = fakeLine(), send = hook(db, line);
  await send([{ type: 'join', replyToken: 'r', source: { type: 'group', groupId: 'Cgroup1' } }]);
  assert.match(line.sent[0].text, /alerts set here go to the whole group/);
  await send([msg('@Wanna Tennis ? hello', G, { mentionees: [{ index: 0, length: 15, isSelf: true }] })]);
  assert.match(line.sent[1].text, /whole group/);
});

test('groups: an alert set in the group belongs to the group and is pushed to the group', async () => {
  const db = openDb(':memory:'), line = fakeLine(), send = hook(db, line);
  await send([msg('alert sat 18-21 2h goat')]);
  assert.match(line.sent[0].text, /message this group/);
  const [w] = db.listWatches('Cgroup1');
  assert.equal(w.createdBy, 'Ualice');
  assert.equal(db.listWatches('Ualice').length, 0);
  assert.equal(db.isAdmin('Ualice'), false);                              // admin = first person to DM, not group chatter
  line.sent.length = 0;
  await runAlerts({ db, catalog: CAT, snapshot: SNAP, line, now: NOW, log: quiet });
  assert.deepEqual(line.sent.map((m) => [m.kind, m.to]), [['push', 'Cgroup1']]);
});

test('groups: removing the bot cancels that group\'s alerts and website access', async () => {
  const db = openDb(':memory:'), line = fakeLine(), send = hook(db, line);
  await send([msg('alert sat 18-21 2h')]);
  const code = db.createLinkCode('Cgroup1', 'Tuesday Tennis');
  const { token } = db.redeemLinkCode(code);
  await send([{ type: 'leave', source: { type: 'group', groupId: 'Cgroup1' } }]);
  assert.equal(db.listWatches('Cgroup1').length, 0);
  assert.equal(db.tokenTarget(token), null);
});

// ─── website ────────────────────────────────────────────────────────────────
const api = (db, o) => handleApi({ db, catalog: CAT, snapshot: SNAP, limiter: o.limiter || createLimiter(), now: NOW, ip: '1.2.3.4', ...o });

test('web: "link" in a group gives a code; the code links a browser to THAT group, once', async () => {
  const db = openDb(':memory:'), line = fakeLine(), send = hook(db, line);
  await send([msg('link')]);
  const code = line.sent[0].text.match(/(\d{6})/)[1];
  const r = await api(db, { method: 'POST', path: '/api/link', body: { code } });
  assert.equal(r.status, 200);
  assert.equal(r.body.label, 'Tuesday Tennis');
  assert.equal((await api(db, { method: 'POST', path: '/api/link', body: { code } })).status, 400);  // one-time
  const created = await api(db, { method: 'POST', path: '/api/alerts', token: r.body.token,
    body: { dayKind: 'date', dayValue: '2026-10-03', fromH: 18, toH: 21, minHours: 2, place: 'all', venues: ['goat'] } });
  assert.equal(created.status, 200);
  assert.equal(created.body.freeNow[0].time, '18:00–20:00');
  assert.equal(created.body.freeNow[0].url, 'https://g.test/?date=2026-10-03');
  const [w] = db.listWatches('Cgroup1');
  assert.equal(w.origin, 'web');
  const listed = await api(db, { method: 'GET', path: '/api/alerts', token: r.body.token });
  assert.match(listed.body.alerts[0].text, /Sat 3 Oct · 18:00–21:00 · 2h · GOAT57/);
  assert.deepEqual(listed.body.venues, [{ id: 'goat', name: 'GOAT57' }]);   // only live venues offered
});

test('web: a browser can only touch its own chat\'s alerts', async () => {
  const db = openDb(':memory:');
  const mine = db.redeemLinkCode(db.createLinkCode('Cgroup1', 'G')).token;
  const otherId = db.addWatch('Ustranger', { venues: [], dayKind: 'any', dayValue: null, fromH: 18, toH: 21, minHours: 1, place: 'all' });
  assert.equal((await api(db, { method: 'DELETE', path: `/api/alerts/${otherId}`, token: mine })).status, 404);
  assert.equal(db.listWatches('Ustranger').length, 1);
  assert.equal((await api(db, { method: 'GET', path: '/api/alerts', token: 'forged' })).status, 401);
  assert.equal((await api(db, { method: 'GET', path: '/api/alerts' })).status, 401);
});

test('web: wrong codes are rate-limited (brute force)', async () => {
  const db = openDb(':memory:'), limiter = createLimiter();
  for (let i = 0; i < 5; i++) assert.equal((await api(db, { method: 'POST', path: '/api/link', body: { code: '000000' }, limiter })).status, 400);
  const real = db.createLinkCode('U1', 'Me');
  assert.equal((await api(db, { method: 'POST', path: '/api/link', body: { code: real }, limiter })).status, 429);  // even the right one, for now
  assert.equal((await api(db, { method: 'POST', path: '/api/link', body: { code: real }, limiter, ip: '5.6.7.8' })).status, 200);
});

test('web: same rules as chat — the website can\'t create what the bot would refuse', async () => {
  const db = openDb(':memory:');
  const token = db.redeemLinkCode(db.createLinkCode('U1', 'Me')).token;
  const post = (b) => api(db, { method: 'POST', path: '/api/alerts', token,
    body: { dayKind: 'date', dayValue: '2026-10-03', fromH: 18, toH: 21, minHours: 1, place: 'all', venues: [], ...b } });
  const chat = parseCommand('alert sat 18-19 2h', { catalog: CAT, clock: { today: '2026-09-29', hour: 14 } });
  assert.equal((await post({ fromH: 18, toH: 19, minHours: 2 })).body.error, chat.reason);
  assert.match((await post({ dayValue: '2026-09-01' })).body.error, /already passed/);
  assert.match((await post({ venues: ['ace'] })).body.error, /checked live/);        // self-check venue
  assert.match((await post({ place: 'roof' })).body.error, /Court type/);
  assert.equal((await post({ dayKind: 'weekly', dayValue: '6' })).status, 200);
});

// ─── "send to LINE" buttons + tap-to-link ───────────────────────────────────
import { watchToCommand, roundTrips } from '../lib/commands.js';
import { handleText } from '../lib/bot.js';
import { CATALOG } from '../catalog.js';

test('send-to-LINE: every alert the website can build reads back as the same alert (real catalog)', () => {
  const clock = { today: '2026-09-29', hour: 14 };
  const live = CATALOG.filter((v) => v.source.type !== 'manual').map((v) => v.id);
  let checked = 0;
  for (const day of [['date', '2026-09-30'], ['date', '2026-10-03'], ['date', '2026-12-31'], ['weekly', '0'], ['weekly', '6'], ['any', null]]) {
    for (const [fromH, toH] of [[0, 24], [5, 9], [18, 21], [20, 24], [6, 12]]) {
      for (const minHours of [1, 2, 3]) {
        if (toH - fromH < minHours) continue;
        for (const place of ['all', 'indoor', 'outdoor']) {
          for (const venues of [[], [live[0]], live.slice(1, 3), live]) {
            const w = { dayKind: day[0], dayValue: day[1], fromH, toH, minHours, place, venues };
            const text = watchToCommand(w);
            assert.ok(roundTrips(w, text, { catalog: CATALOG, clock }), `"${text}" did not read back as ${JSON.stringify(w)}`);
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 1000);
});

test('send-to-LINE: /api/command builds both LINE links, and validates like chat', async () => {
  const db = openDb(':memory:');
  const body = { dayKind: 'date', dayValue: '2026-10-03', fromH: 18, toH: 21, minHours: 2, place: 'all', venues: ['goat'] };
  const off = await api(db, { method: 'POST', path: '/api/command', body });
  assert.equal(off.body.text, 'alert 3/10 18-21 2h goat');
  assert.equal(off.body.lineUrl, null);                                     // no bot ID configured yet
  assert.equal(off.body.shareUrl, `https://line.me/R/share?text=${encodeURIComponent('alert 3/10 18-21 2h goat')}`);
  const on = await api(db, { method: 'POST', path: '/api/command', body, config: { botBasicId: '@wanna' } });
  assert.equal(on.body.lineUrl, `https://line.me/R/oaMessage/%40wanna/?${encodeURIComponent('alert 3/10 18-21 2h goat')}`);
  assert.match((await api(db, { method: 'POST', path: '/api/command', body: { ...body, toH: 19 } })).body.error, /shorter than 2h/);
  const cfg = (await api(db, { method: 'GET', path: '/api/config', config: { botBasicId: '@wanna' } })).body;
  assert.equal(cfg.botBasicId, '@wanna');
  assert.equal(cfg.addFriendUrl, 'https://line.me/R/ti/p/%40wanna');          // alerts need friendship
  assert.equal((await api(db, { method: 'GET', path: '/api/config' })).body.addFriendUrl, null);
});

test('tap-to-link: with a public URL the bot sends a one-tap link that opens in the normal browser', async () => {
  const db = openDb(':memory:');
  const reply = await handleText({ userId: 'U1', text: 'link', db, catalog: CAT, snapshot: SNAP, now: NOW, publicUrl: 'https://wanna.example/' });
  const m = reply.match(/https:\/\/wanna\.example\/\?link=(\d{6})&openExternalBrowser=1/);
  assert.ok(m, reply);
  assert.equal((await api(db, { method: 'POST', path: '/api/link', body: { code: m[1] } })).status, 200);
  const noUrl = await handleText({ userId: 'U1', text: 'link', db, catalog: CAT, snapshot: SNAP, now: NOW });
  assert.match(noUrl, /Website code: \d{6}/);                              // falls back to the code
});
