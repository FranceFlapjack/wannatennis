// Website alert management. A browser gets access to ONE chat's alerts (a person or a
// group) by entering a 6-digit code the bot gave inside that chat ("link"). After that it
// sends the token it received as `Authorization: Bearer <token>`.
//   GET    /api/config                    -> which "send to LINE" buttons can work
//   POST   /api/command       {watch}      -> { text, summary, lineUrl, shareUrl }  (no linking needed:
//                                             the message is sent BY the person, from inside LINE)
//   POST   /api/link          {code}      -> { token, label }
//   DELETE /api/link                       -> forget this browser
//   GET    /api/alerts                     -> { label, alerts, venues }
//   POST   /api/alerts        {watch}      -> { alert, freeNow }
//   DELETE /api/alerts/:id
// Same rules as chat (checkWatch), so the web can't create an alert the bot would refuse.
import { checkWatch, describeWatch, fmtDate, hh, watchFrom, lineCommand } from './commands.js';
import { findSlots, shortCourt } from './alerts.js';
import { bkkClock } from './state.js';
import { MAX_WATCHES } from './bot.js';

const isLive = (v) => v.source?.type && v.source.type !== 'manual';

/**
 * The visitor's IP, for the link-code limiter. Behind our own proxy on this machine (the
 * Cloudflare tunnel, or Caddy on the server) every request arrives from loopback, so read
 * the header that proxy sets — and ONLY then, so a visitor can't fake it.
 * `header`: 'cf-connecting-ip' (tunnel) or 'x-forwarded-for' (Caddy, which overwrites it).
 */
export function clientIp(headers, remoteAddress, header = 'cf-connecting-ip') {
  const loopback = /^(127\.|::1$|::ffff:127\.)/.test(remoteAddress || '');
  const fromProxy = loopback ? String(headers?.[header] || '').split(',')[0].trim() : '';
  return fromProxy || remoteAddress || '?';
}

// Brute-force guard for link codes: per visitor and overall, per 10 minutes.
const WINDOW_MS = 10 * 60_000, PER_IP = 5, GLOBAL = 30;
export function createLimiter() {
  const hits = new Map(); let global = [];
  return {
    blocked(ip, now = Date.now()) {
      global = global.filter((t) => now - t < WINDOW_MS);
      const mine = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
      hits.set(ip, mine);
      return mine.length >= PER_IP || global.length >= GLOBAL;
    },
    fail(ip, now = Date.now()) { hits.set(ip, [...(hits.get(ip) || []), now]); global.push(now); },
  };
}

function view(w, n, catalog) {
  return { id: w.id, n, text: describeWatch(w, catalog), dayKind: w.dayKind, dayValue: w.dayValue,
    fromH: w.fromH, toH: w.toH, minHours: w.minHours, place: w.place, venues: w.venues, origin: w.origin };
}

export async function handleApi({ method, path, body, token, ip = '?', db, catalog, snapshot, limiter, now = Date.now(), config = {} }) {
  const clock = bkkClock(now);

  if (path === '/api/config' && method === 'GET') {
    const id = config.botBasicId || null;
    // Alerts are PUSH messages, and LINE only pushes to people who added the bot as a friend.
    return { status: 200, body: { botBasicId: id, addFriendUrl: id ? `https://line.me/R/ti/p/${encodeURIComponent(id)}` : null } };
  }

  if (path === '/api/command' && method === 'POST') {
    const r = lineCommand(body, { catalog, clock, botBasicId: config.botBasicId || null });
    return r.error ? { status: r.error.startsWith('Could not build') ? 500 : 400, body: { error: r.error } } : { status: 200, body: r };
  }

  if (path === '/api/link' && method === 'POST') {
    if (limiter.blocked(ip, now)) return { status: 429, body: { error: 'Too many wrong codes — wait 10 minutes and try again.' } };
    const code = String(body?.code ?? '').replace(/\D/g, '');
    const r = code.length === 6 ? db.redeemLinkCode(code) : null;
    if (!r) { limiter.fail(ip, now); return { status: 400, body: { error: 'That code is wrong or expired — send "link" to the bot for a new one.' } }; }
    return { status: 200, body: { token: r.token, label: r.label } };
  }

  // everything below needs a linked browser
  const who = db.tokenTarget(token);
  if (!who) return { status: 401, body: { error: 'Not linked — send "link" to the bot and enter the code.' } };

  if (path === '/api/link' && method === 'DELETE') { db.deleteToken(token); return { status: 200, body: { ok: true } }; }

  if (path === '/api/alerts' && method === 'GET') {
    const alerts = db.listWatches(who.targetId).map((w, i) => view(w, i + 1, catalog));
    const venues = catalog.filter(isLive).map((v) => ({ id: v.id, name: v.name }));
    return { status: 200, body: { label: who.label, alerts, venues } };
  }

  if (path === '/api/alerts' && method === 'POST') {
    const w = watchFrom(body);
    const why = checkWatch(w, { catalog, clock });
    if (why) return { status: 400, body: { error: why } };
    if (db.listWatches(who.targetId).length >= MAX_WATCHES) return { status: 400, body: { error: `Already ${MAX_WATCHES} alerts — cancel one first.` } };
    const id = db.addWatch(who.targetId, w, { origin: 'web' });
    const list = db.listWatches(who.targetId);
    const n = list.findIndex((x) => x.id === id) + 1;
    const freeNow = findSlots(w, snapshot, catalog, { now }).slice(0, 20).map((s) => {
      const v = catalog.find((x) => x.id === s.venueId);
      return { venue: v?.name ?? s.venueId, date: fmtDate(s.date), time: `${hh(s.start)}–${hh(s.end)}`,
        courts: s.courts.map(shortCourt), url: v?.bookingUrlForDate ? v.bookingUrlForDate.replace('{date}', s.date) : v?.bookingUrl };
    });
    // nothing for the full run? show single free hours so "nothing" isn't misleading
    const shorterFree = !freeNow.length && w.minHours > 1
      ? findSlots({ ...w, minHours: 1 }, snapshot, catalog, { now }).slice(0, 20).map((s) => {
        const v = catalog.find((x) => x.id === s.venueId);
        return { venue: v?.name ?? s.venueId, date: fmtDate(s.date), time: `${hh(s.start)}–${hh(s.end)}`,
          courts: s.courts.map(shortCourt), url: v?.bookingUrlForDate ? v.bookingUrlForDate.replace('{date}', s.date) : v?.bookingUrl };
      })
      : [];
    return { status: 200, body: { alert: view(list[n - 1], n, catalog), freeNow, shorterFree } };
  }

  const del = path.match(/^\/api\/alerts\/(\d+)$/);
  if (del && method === 'DELETE') {
    const w = db.getWatch(Number(del[1]));
    if (!w || w.userId !== who.targetId) return { status: 404, body: { error: 'No such alert.' } };  // can't touch other chats'
    db.cancelWatch(w.id);
    return { status: 200, body: { ok: true } };
  }
  return { status: 404, body: { error: 'Not found' } };
}
