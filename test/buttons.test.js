// Tap-instead-of-type: quick-reply buttons, the 4-tap alert picker, "free" and "web".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menu, cancelButtons, pickerStep, MAX_ITEMS, MAX_LABEL } from '../lib/menu.js';
import { handleMessage, handlePostback } from '../lib/bot.js';
import { handleWebhook } from '../lib/webhook.js';
import { createLineClient, signBody } from '../lib/line.js';
import { openDb } from '../lib/db.js';

const bkk = (date, h) => Date.parse(`${date}T00:00:00Z`) + (h - 7) * 3_600_000;
const NOW = bkk('2026-09-29', 14);
const CLOCK = { today: '2026-09-29', hour: 14 };
const CAT = [
  { id: 'goat', name: 'G.O.A.T. 57', aliases: ['goat'], area: 'Rama 3', indoor: true, source: { type: 'reservationSystem' }, bookingUrl: 'https://g.test/' },
  { id: 'ruji', name: 'Rujiseri Tennis Courts', aliases: ['ruji'], area: 'Phaya Thai', indoor: false, source: { type: 'skedda' }, bookingUrl: 'https://r.test/' },
  { id: 'ace', name: 'Ace of Clubs', aliases: ['ace'], area: 'Rama IV', indoor: true, source: { type: 'manual' }, bookingUrl: 'https://a.test/' },
];
const SNAP = { generatedAt: new Date(NOW).toISOString(), dates: ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'],
  venues: { goat: { live: true, errorDates: [], byDate: { '2026-10-03': { 'Court 1': [18, 19, 20] }, '2026-09-30': { 'Court 1': [9] } } } } };
const labels = (items) => items.map((i) => i.action.label);
const within = (items) => items.length <= MAX_ITEMS && items.every((i) => [...i.action.label].length <= MAX_LABEL);

test('buttons: the menu fits LINE limits; website button only when the site is online', () => {
  const on = menu({ publicUrl: 'https://wanna.example' }), off = menu({});
  assert.ok(within(on) && within(off));
  assert.deepEqual(on.find((i) => i.action.type === 'uri').action.uri, 'https://wanna.example');
  assert.equal(off.some((i) => i.action.type === 'uri'), false);
  assert.ok(within(cancelButtons(20)));
  assert.deepEqual(labels(cancelButtons(2)).slice(0, 3), ['✖ Cancel 1', '✖ Cancel 2', '✖ Cancel all']);
});

test('picker: 4 taps — day → time → length → courts — makes the same alert as typing it', () => {
  const ctx = { catalog: CAT, clock: CLOCK };
  const day = pickerStep('w=start', null, ctx);
  assert.ok(within(day.quick));
  const sat = day.quick.find((i) => i.action.label === 'Sat 3 Oct');
  const time = pickerStep(sat.action.data, null, ctx);
  const evening = time.quick.find((i) => i.action.label.startsWith('Evening'));
  const len = pickerStep(evening.action.data, null, ctx);
  assert.deepEqual(labels(len.quick), ['1 hr', '2 hrs', '3 hrs']);
  const courts = pickerStep(len.quick[1].action.data, null, ctx);
  assert.ok(labels(courts.quick).includes('G.O.A.T. 57'));
  assert.ok(!labels(courts.quick).includes('Ace of Clubs'));           // self-check venues can't be watched
  const done = pickerStep(courts.quick.find((i) => i.action.label === 'G.O.A.T. 57').action.data, null, ctx);
  assert.deepEqual(done.watch, { venues: ['goat'], place: 'all', dayKind: 'date', dayValue: '2026-10-03', fromH: 17, toH: 22, minHours: 2, selfCheckNamed: [] });
});

test('picker: the 📅 calendar button, and "too late today" is never offered', () => {
  const ctx = { catalog: CAT, clock: CLOCK };
  const cal = pickerStep('w=start', null, ctx).quick.find((i) => i.action.type === 'datetimepicker');
  assert.deepEqual([cal.action.mode, cal.action.min], ['date', '2026-09-29']);
  const after = pickerStep(cal.action.data, '2026-10-20', ctx);
  assert.match(after.text, /Tue 20 Oct — what time\?/);
  const late = { catalog: CAT, clock: { today: '2026-09-29', hour: 20 } };
  const todayTimes = pickerStep('w=day&d=date:2026-09-29', null, late);
  assert.deepEqual(labels(todayTimes.quick), ['Evening 17–22', 'Late 19–24', 'Any time']);
  assert.deepEqual(labels(pickerStep('w=time&d=date:2026-09-29&t=17-22', null, late).quick), ['1 hr']);
  assert.ok(!labels(pickerStep('w=start', null, { catalog: CAT, clock: { today: '2026-09-29', hour: 23 } }).quick).includes('Today'));
});

test('picker: tampered or stale buttons fail safely with a restart, never a bad alert', () => {
  const ctx = { catalog: CAT, clock: CLOCK };
  assert.match(pickerStep('w=go&d=date:2026-10-03&t=17-22&h=9&c=all', null, ctx).text, /1 to 6 hours/);
  assert.match(pickerStep('w=go&d=date:2026-09-01&t=17-22&h=1&c=all', null, ctx).text, /already passed/);
  assert.match(pickerStep('w=go&d=date:2026-10-03&t=17-22&h=1&c=v:ace', null, ctx).text, /checked live/);
  assert.match(pickerStep('w=day&d=pick', null, ctx).text, /which day/);   // calendar without a date
  assert.match(pickerStep('garbage', null, ctx).text, /which day/);
});

test('bot: picker postback creates the alert; replies carry buttons; "my alerts" gets cancel buttons', async () => {
  const db = openDb(':memory:');
  const base = { db, catalog: CAT, snapshot: SNAP, now: NOW, targetId: 'U1', userId: 'U1', inGroup: false, publicUrl: 'https://wanna.example' };
  const r = handlePostback({ ...base, data: 'w=go&d=date:2026-10-03&t=17-22&h=2&c=v:goat' });
  assert.match(r.text, /Alert 1 set[\s\S]*18:00–20:00 · Court 1/);
  assert.ok(labels(r.quick).includes('🔔 New alert'));
  const list = await handleMessage({ ...base, text: 'my alerts' });
  assert.deepEqual(labels(list.quick).slice(0, 1), ['✖ Cancel 1']);
  const help = await handleMessage({ ...base, text: 'help' });
  assert.match(help.text, /Tap the buttons below[\s\S]*🌐 https:\/\/wanna\.example/);
});

test('bot: "free" lists what is free, "web" gives the site', async () => {
  const db = openDb(':memory:');
  const base = { db, catalog: CAT, snapshot: SNAP, now: NOW, targetId: 'U1', userId: 'U1', inGroup: false, publicUrl: 'https://wanna.example' };
  const free = await handleMessage({ ...base, text: 'free tomorrow' });
  assert.match(free.text, /Free courts · Wed 30 Sep[\s\S]*09:00–10:00 · Court 1[\s\S]*https:\/\/wanna\.example/);
  const sat = await handleMessage({ ...base, text: 'free sat 18-21' });
  assert.match(sat.text, /Sat 3 Oct · 18:00–21:00[\s\S]*18:00–19:00/);
  assert.match((await handleMessage({ ...base, text: 'web' })).text, /https:\/\/wanna\.example/);
  const group = await handleMessage({ ...base, inGroup: true, text: 'free tomorrow?' });
  assert.equal(group, null);                                          // casual group chat stays ignored
});

test('webhook: a tapped picker button (postback) is answered with the next question + buttons', async () => {
  const db = openDb(':memory:'); const sent = [];
  const line = { async reply(_t, text, to, quick) { sent.push({ text, to, quick }); } };
  const events = [{ type: 'postback', replyToken: 'r', source: { type: 'group', groupId: 'Cg', userId: 'Ua' }, postback: { data: 'w=day&d=date:2026-10-03' } }];
  const raw = Buffer.from(JSON.stringify({ events }));
  const res = await handleWebhook({ rawBody: raw, signature: signBody('s', raw), secret: 's', db, line, catalog: CAT, snapshot: () => SNAP, now: NOW,
    log: { log() {}, warn() {}, error() {} } });
  assert.equal(res.status, 200);
  assert.equal(sent[0].to, 'Cg');
  assert.match(sent[0].text, /what time/);
  assert.ok(sent[0].quick.length > 0);
});

test('line: buttons are sent as LINE quickReply items', async () => {
  let body;
  const client = createLineClient({ token: 't', fetchImpl: async (_u, o) => { body = JSON.parse(o.body); return { ok: true }; } });
  await client.reply('rt', 'hi', 'U1', menu({}));
  assert.equal(body.messages[0].quickReply.items[0].action.label, '🔔 New alert');
  await client.push('U1', 'plain');
  assert.equal(body.messages[0].quickReply, undefined);
});

test('picker: "new alert" / bare "alert" / "ตั้งแจ้งเตือน" start the picker — and never create a catch-all alert', async () => {
  for (const text of ['new alert', 'alert', 'ตั้งแจ้งเตือน', 'แจ้งเตือน']) {
    const db = openDb(':memory:');
    const r = await handleMessage({ db, catalog: CAT, snapshot: SNAP, now: NOW, targetId: 'U1', userId: 'U1', inGroup: false, text });
    assert.match(r.text, /which day/, text);
    assert.ok(r.quick.some((i) => i.action.type === 'datetimepicker'), text);
    assert.equal(db.listWatches('U1').length, 0, text);
  }
});
