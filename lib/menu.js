// Tap-instead-of-type for LINE: quick-reply buttons under the bot's messages (phone apps;
// works in 1:1 and group chats), and a 4-tap alert picker: day → time → length → courts.
// The picker is STATELESS: every button carries the choices so far in its postback data,
// so nothing has to be remembered between taps (and two people in a group can't clash).
import { addDays, fmtDate, checkWatch } from './commands.js';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MAX_ITEMS = 13, MAX_LABEL = 20;                    // LINE limits
const clip = (s) => ([...s].length > MAX_LABEL ? `${[...s].slice(0, MAX_LABEL - 1).join('')}…` : s);
const item = (label, action) => ({ type: 'action', action: { ...action, label: clip(label) } });
const say = (label, text) => item(label, { type: 'message', text });
const tap = (label, data, displayText = label) => item(label, { type: 'postback', data, displayText });
const isLive = (v) => v.source?.type && v.source.type !== 'manual';

export const WINDOWS = [                                           // label, from, to
  ['Morning 06–12', 6, 12], ['Midday 11–15', 11, 15], ['Afternoon 13–17', 13, 17],
  ['Evening 17–22', 17, 22], ['Late 19–24', 19, 24], ['Any time', 0, 24],
];

/** The standard buttons under every reply. */
export function menu({ publicUrl } = {}) {
  const items = [
    tap('🔔 New alert', 'w=start', 'New alert'),
    say('🎾 Free today', 'free today'),
    say('🎾 Free tomorrow', 'free tomorrow'),
    say('📋 My alerts', 'my alerts'),
  ];
  if (publicUrl) items.push(item('🌐 Website', { type: 'uri', uri: publicUrl }));
  items.push(say('🔗 Manage on web', 'link'), say('❓ Help', 'help'));
  return items;
}

/** "Cancel 1", "Cancel 2"… under the alert list. */
export function cancelButtons(count) {
  const items = [];
  for (let i = 1; i <= Math.min(count, 8); i++) items.push(say(`✖ Cancel ${i}`, `cancel ${i}`));
  if (count > 1) items.push(say('✖ Cancel all', 'cancel all'));
  items.push(tap('🔔 New alert', 'w=start', 'New alert'));
  return items.slice(0, MAX_ITEMS);
}

// can a `hours`-long game still start in [from, to) on that day?
const fits = (dayKind, dayValue, from, to, hours, clock) =>
  dayKind !== 'date' || dayValue !== clock.today ? to - from >= hours : Math.max(from, clock.hour + 1) + hours <= to;

/**
 * One step of the picker. `data` is the tapped button's postback data (URLSearchParams),
 * `picked` the date from the calendar button (if used).
 * Returns { text, quick } for the next question, or { watch } when all four are chosen.
 */
export function pickerStep(data, picked, { catalog, clock }) {
  const p = new URLSearchParams(data);
  if (p.get('d') === 'pick' && picked) p.set('d', `date:${picked}`);
  const [dayKind, dayValue = null] = (p.get('d') || '').split(':');
  const step = p.get('w');
  const keep = (extra) => { const q = new URLSearchParams(p); for (const [k, v] of Object.entries(extra)) q.set(k, v); return q.toString(); };
  const dayText = dayKind === 'date' ? fmtDate(dayValue) : dayKind === 'weekly' ? `every ${DOW[Number(dayValue)]}` : 'any day';

  if (step !== 'start' && !['date', 'weekly', 'any'].includes(dayKind)) return pickerStep('w=start', null, { catalog, clock });
  if (step === 'start' || !dayKind) {
    const items = [];
    const today = clock.today, tomorrow = addDays(today, 1);
    if (clock.hour <= 22) items.push(tap('Today', keep({ w: 'day', d: `date:${today}` }), `Today (${fmtDate(today)})`));
    items.push(tap('Tomorrow', keep({ w: 'day', d: `date:${tomorrow}` }), `Tomorrow (${fmtDate(tomorrow)})`));
    for (let i = 2; i <= 6; i++) { const d = addDays(today, i); items.push(tap(fmtDate(d), keep({ w: 'day', d: `date:${d}` }))); }
    items.push(item('📅 Pick a date', { type: 'datetimepicker', data: keep({ w: 'day', d: 'pick' }), mode: 'date',
      initial: tomorrow, min: today, max: addDays(today, 60) }));
    items.push(tap('Every Sat', keep({ w: 'day', d: 'weekly:6' })), tap('Every Sun', keep({ w: 'day', d: 'weekly:0' })));
    items.push(tap('Any day', keep({ w: 'day', d: 'any:' })));
    return { text: '🔔 New alert — which day?', quick: items };
  }

  if (step === 'day') {
    const items = WINDOWS.filter(([, a, b]) => fits(dayKind, dayValue, a, b, 1, clock))
      .map(([label, a, b]) => tap(label, keep({ w: 'time', t: `${a}-${b}` })));
    if (!items.length) return { text: `It's too late for ${dayText} — pick another day.`, quick: pickerStep('w=start', null, { catalog, clock }).quick };
    return { text: `${dayText[0].toUpperCase()}${dayText.slice(1)} — what time?`, quick: items };
  }

  const [from, to] = (p.get('t') || '').split('-').map(Number);
  if (step === 'time') {
    const items = [1, 2, 3].filter((h) => fits(dayKind, dayValue, from, to, h, clock))
      .map((h) => tap(`${h} hr${h > 1 ? 's' : ''}`, keep({ w: 'len', h: String(h) }), `Play ${h} hr${h > 1 ? 's' : ''}`));
    return { text: 'How long do you want to play? (same court, back to back)', quick: items };
  }

  if (step === 'len') {
    const items = [
      tap('All courts', keep({ w: 'go', c: 'all' })),
      tap('Indoor only', keep({ w: 'go', c: 'indoor' })),
      tap('Outdoor only', keep({ w: 'go', c: 'outdoor' })),
      ...catalog.filter(isLive).map((v) => tap(v.name, keep({ w: 'go', c: `v:${v.id}` }))),
    ];
    return { text: 'Which courts?', quick: items.slice(0, MAX_ITEMS) };
  }

  if (step === 'go') {
    const c = p.get('c') || 'all';
    const watch = {
      venues: c.startsWith('v:') ? [c.slice(2)] : [],
      place: c === 'indoor' || c === 'outdoor' ? c : 'all',
      dayKind, dayValue: dayKind === 'any' ? null : dayValue,
      fromH: from, toH: to, minHours: Number(p.get('h')), selfCheckNamed: [],
    };
    const why = checkWatch(watch, { catalog, clock });
    if (why) return { text: `${why}\n\nLet's try again:`, quick: pickerStep('w=start', null, { catalog, clock }).quick };
    return { watch };
  }
  return { text: 'Let’s start again — which day?', quick: pickerStep('w=start', null, { catalog, clock }).quick };
}
