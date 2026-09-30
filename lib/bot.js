// What the bot says back to a message. Pure-ish: all state comes in through ctx.
// targetId = the chat alerts belong to (a person, or a whole GROUP/room);
// senderId = the person who typed (may be unknown in groups). Returns null = stay silent.
import { parseCommand, describeWatch, fmtDate } from './commands.js';
import { findSlots, formatSlots } from './alerts.js';
import { bkkClock } from './state.js';
import { menu, cancelButtons, pickerStep } from './menu.js';

export const MAX_WATCHES = 10;

export const HELP = [
  '🎾 Wanna Tennis ? — I message you when a court frees up.',
  'Tap the buttons below — or type:',
  '',
  'Set an alert:',
  '• alert Sat 18-21 2h',
  '• alert tomorrow evening indoor',
  '• alert every Sun 8-12 goat',
  '• alert 3/10 18-22 2h beat',
  'ไทยก็ได้: แจ้งเตือน เสาร์ 18-21 2ชม',
  '',
  'Your alerts: my alerts · cancel 2 · cancel all',
  'Manage alerts on the website: link',
  '',
  'Checked live: Hatch, Beat, GOAT57, Ruji. Other courts need a login to see availability — use the website.',
].join('\n');

export const GROUP_HELP = [
  '🎾 Wanna Tennis ? — alerts set here go to the whole group.',
  'Tap the buttons below — or type:',
  '',
  '• alert Sat 18-21 2h',
  '• แจ้งเตือน เสาร์ 18-21 2ชม โกท',
  '• my alerts · cancel 2 · cancel all',
  '• link — manage this group\'s alerts on the website',
].join('\n');

/** Create an alert and describe it (+ what's free right now). Shared by typed commands and the picker. */
export function createAlert(cmd, { db, catalog, snapshot, now, targetId, userId, inGroup }) {
  if (db.listWatches(targetId).length >= MAX_WATCHES) return `There are already ${MAX_WATCHES} alerts here — cancel one first (my alerts).`;
  const id = db.addWatch(targetId, cmd, { origin: 'line', createdBy: userId || null });
  const n = db.listWatches(targetId).findIndex((w) => w.id === id) + 1;
  const now_ = findSlots(cmd, snapshot, catalog, { now });
  const lines = [`✅ Alert ${n} set`, describeWatch(cmd, catalog), '', `I'll message ${inGroup ? 'this group' : 'you'} when a matching court frees up.`];
  if (cmd.selfCheckNamed?.length) {
    lines.push(`(Not watching ${cmd.selfCheckNamed.map((x) => catalog.find((v) => v.id === x)?.name).join(', ')} — no public availability.)`);
  }
  if (now_.length) lines.push('', `Free right now:\n\n${formatSlots(now_, catalog, { max: 8 })}`);
  else {
    // explain a "nothing" when shorter slots exist — e.g. free hours that aren't back-to-back
    const single = cmd.minHours > 1 ? findSlots({ ...cmd, minHours: 1 }, snapshot, catalog, { now }) : [];
    lines.push('', single.length
      ? `Nothing free for ${cmd.minHours}h in a row right now (same court).\nSingle free hours in that window:\n\n${formatSlots(single, catalog, { max: 8 })}`
      : 'Nothing matching is free right now.');
  }
  return lines.join('\n');
}

export async function handleText({ userId, targetId = userId, inGroup = false, addressed = false, linkLabel = null,
  publicUrl = null, text, db, catalog, snapshot, now = Date.now(), selfCheck = null }) {
  const clock = bkkClock(now);
  const cmd = parseCommand(text, { catalog, clock, inGroup: inGroup && !addressed });
  const isAdmin = !!userId && db.isAdmin(userId);
  const help = inGroup ? GROUP_HELP : HELP;

  switch (cmd.type) {
    case 'help':
      return help;
    case 'unknown':
      // in a group, normal chat isn't for us — unless they @mentioned the bot
      return inGroup && !addressed ? null : `I didn't get that.\n\n${help}`;

    case 'link': {
      const code = db.createLinkCode(targetId, linkLabel || (inGroup ? 'LINE group' : 'My LINE chat'));
      const whose = inGroup ? 'this group\'s' : 'your';
      if (publicUrl) {   // one tap: opens the site already linked, in the phone's normal browser
        const url = `${publicUrl.replace(/\/$/, '')}/?link=${code}&openExternalBrowser=1`;
        return `🔗 Tap to manage ${whose} alerts on the website:\n${url}\n\n(works once, for 10 minutes — or enter code ${code} on the site)`;
      }
      return `🔗 Website code: ${code}\n(valid 10 minutes, works once)\n\nOn the website open "🔔 LINE alerts" and enter it — `
        + `that browser can then set and cancel ${whose} alerts.`;
    }

    case 'error':
      if (cmd.reason === 'selfcheck-only') {
        const vs = cmd.venues.map((id) => catalog.find((v) => v.id === id)).filter(Boolean);
        return `I can't watch ${vs.map((v) => v.name).join(', ')} — they need a login or phone to see availability, so there's nothing for me to check.\n\n`
          + vs.map((v) => `${v.name}: ${v.lineUrl || v.bookingUrl}`).join('\n');
      }
      return `${cmd.reason}\n\nExample: alert Sat 18-21 2h`;

    case 'alert':
      return createAlert(cmd, { db, catalog, snapshot, now, targetId, userId, inGroup });

    case 'free': {
      const w = cmd.watch;
      const slots = findSlots(w, snapshot, catalog, { now });
      const head = `🎾 Free courts · ${fmtDate(w.dayValue)}${w.fromH === 0 && w.toH === 24 ? '' : ` · ${String(w.fromH).padStart(2, '0')}:00–${String(w.toH).padStart(2, '0')}:00`}`;
      const more = publicUrl ? `\n\nAll courts & self-check venues: ${publicUrl}` : '';
      if (!slots.length) return `${head}\n\nNothing free on the live-checked courts.${more}`;
      return `${head}\n\n${formatSlots(slots, catalog, { max: 12 })}${more}`;
    }

    case 'picker':
      return pickerStep('w=start', null, { catalog, clock }).text;

    case 'web':
      return publicUrl ? `🌐 Wanna Tennis ? — free courts in Bangkok:\n${publicUrl}` : 'The website isn’t online yet.';

    case 'list': {
      const ws = db.listWatches(targetId);
      if (!ws.length) return `${inGroup ? 'This group has' : 'You have'} no alerts.\n\nSet one: alert Sat 18-21 2h`;
      return `${inGroup ? 'This group\'s' : 'Your'} alerts:\n${ws.map((w, i) => `${i + 1}. ${describeWatch(w, catalog)}`).join('\n')}\n\nCancel: cancel 1 · cancel all`;
    }

    case 'cancel': {
      const ws = db.listWatches(targetId);
      if (!ws.length) return 'There are no alerts to cancel.';
      if (cmd.which === 'all') { const n = db.cancelAll(targetId); return `Cancelled all ${n} alert${n === 1 ? '' : 's'}.`; }
      if (cmd.which === null) {
        if (ws.length === 1) { db.cancelWatch(ws[0].id); return `Cancelled: ${describeWatch(ws[0], catalog)}`; }
        return `Which one?\n${ws.map((w, i) => `${i + 1}. ${describeWatch(w, catalog)}`).join('\n')}\n\nReply e.g. cancel 1`;
      }
      const w = ws[cmd.which - 1];
      if (!w) return `There's no alert ${cmd.which}. You have ${ws.length}.`;
      db.cancelWatch(w.id);
      return `Cancelled alert ${cmd.which}: ${describeWatch(w, catalog)}`;
    }

    case 'status': {
      if (!isAdmin) return inGroup ? null : help;
      const lines = [`Checking status (data ${snapshot.generatedAt ? new Date(snapshot.generatedAt).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' }) : 'none'}):`];
      for (const v of catalog.filter((x) => x.source?.type !== 'manual')) {
        const h = db.health(v.id);
        lines.push(`${h.fails ? '⚠️' : '✅'} ${v.name}${h.fails ? ` — ${h.fails} failed checks: ${h.last_error}` : ''}`);
      }
      lines.push('', `Active alerts: ${db.activeWatches().length}`);
      return lines.join('\n');
    }

    case 'selfcheck': {
      if (!isAdmin || !selfCheck) return inGroup ? null : help;
      const r = await selfCheck();
      return r.problems.length ? `🔍 Self-check (${r.date}) found:\n• ${r.problems.join('\n• ')}` : `🔍 Self-check (${r.date}): all venues OK.`;
    }
    default:
      return inGroup ? null : help;
  }
}

/**
 * A text message -> { text, quick } (quick = tap-able buttons), or null to stay silent.
 * Buttons: the menu under everything; under "my alerts", cancel buttons.
 */
export async function handleMessage(ctx) {
  const text = await handleText(ctx);
  if (text == null) return null;
  const clock = bkkClock(ctx.now ?? Date.now());
  const cmd = parseCommand(ctx.text, { catalog: ctx.catalog, clock, inGroup: ctx.inGroup && !ctx.addressed });
  const count = cmd.type === 'list' ? ctx.db.listWatches(ctx.targetId ?? ctx.userId).length : 0;
  const withSite = cmd.type === 'help' && ctx.publicUrl ? `${text}\n\n🌐 ${ctx.publicUrl}` : text;
  const quick = cmd.type === 'picker' ? pickerStep('w=start', null, { catalog: ctx.catalog, clock }).quick
    : count ? cancelButtons(count) : menu(ctx);
  return { text: withSite, quick };
}

/** A tapped picker button (postback) -> the next question, or the created alert. */
export function handlePostback({ data, params, db, catalog, snapshot, now = Date.now(), targetId, userId, inGroup, publicUrl }) {
  const clock = bkkClock(now);
  const step = pickerStep(data, params?.date || null, { catalog, clock });
  if (!step.watch) return step;
  return { text: createAlert(step.watch, { db, catalog, snapshot, now, targetId, userId, inGroup }), quick: menu({ publicUrl }) };
}
