// POST /line/webhook — verify the signature on the RAW body, then handle each event.
// Works in 1:1 chats and in groups/rooms: alerts belong to the chat they were set in,
// so an alert set in a group is pushed to the whole group.
// Returns { status, body } so it's testable without an HTTP server.
import { verifySignature } from './line.js';
import { handleMessage, handlePostback, HELP, GROUP_HELP } from './bot.js';
import { menu } from './menu.js';

/** Which chat an event belongs to, and who sent it. */
export function chatOf(source = {}) {
  if (source.type === 'group') return { targetId: source.groupId, senderId: source.userId || null, inGroup: true };
  if (source.type === 'room') return { targetId: source.roomId, senderId: source.userId || null, inGroup: true };
  return { targetId: source.userId, senderId: source.userId, inGroup: false };
}

/** Remove @mentions of the bot itself from the text; report whether it was mentioned. */
export function stripSelfMention(message, botUserId) {
  let text = message.text || '';
  const mine = (message.mention?.mentionees || [])
    .filter((m) => m.isSelf || (botUserId && m.userId === botUserId))
    .sort((a, b) => b.index - a.index);                       // cut from the end so indexes stay valid
  for (const m of mine) text = text.slice(0, m.index) + text.slice(m.index + m.length);
  return { text: text.replace(/\s+/g, ' ').trim(), addressed: mine.length > 0 };
}

export async function handleWebhook({ rawBody, signature, secret, db, line, catalog, snapshot, now = Date.now(), selfCheck, publicUrl = null, log = console }) {
  if (!secret) { log.warn('webhook: rejected — LINE_CHANNEL_SECRET not set'); return { status: 503, body: { error: 'LINE is not configured (LINE_CHANNEL_SECRET missing)' } }; }
  if (!verifySignature(secret, rawBody, signature)) {
    // if this appears when you press Verify in LINE, the channel secret in .env doesn't match
    log.warn(`webhook: rejected — bad signature${signature ? ' (secret mismatch?)' : ' (unsigned request)'}`);
    return { status: 401, body: { error: 'bad signature' } };
  }

  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return { status: 400, body: { error: 'invalid JSON' } }; }

  // one line per request: event kinds only — never message text or ids
  const kinds = (payload.events || []).map((e) => `${e.type}${e.source?.type ? `/${e.source.type}` : ''}`);
  log.log(kinds.length ? `webhook: ok — ${kinds.join(', ')}` : 'webhook: ok — LINE verify ping');
  for (const ev of payload.events || []) {        // LINE's "Verify" button sends events: []
    const { targetId, senderId, inGroup } = chatOf(ev.source);
    if (!targetId) continue;
    try {
      if (senderId) { db.touchUser(senderId); }
      if (ev.type === 'follow') {                   // someone added the bot as a friend
        const admin = db.adminIfNone(senderId);
        await line.reply(ev.replyToken, `Hi! ${admin ? '(You’re the admin: you’ll also get health alerts.)\n\n' : ''}${HELP}`, targetId, menu({ publicUrl }));
      } else if (ev.type === 'join') {              // the bot was added to a group/room
        await line.reply(ev.replyToken, `Hi everyone! 👋\n\n${GROUP_HELP}`, targetId, menu({ publicUrl }));
      } else if (ev.type === 'unfollow' || ev.type === 'leave') {
        db.cancelAll(targetId);                     // blocked / removed from the group: stop pushing there
        db.deleteTargetTokens(targetId);
      } else if (ev.type === 'message' && ev.message?.type === 'text') {
        if (senderId && !inGroup) db.adminIfNone(senderId);   // admin = first person to DM the bot
        const { text, addressed } = stripSelfMention(ev.message, payload.destination);
        const isLink = /^(link|link web|connect|เชื่อม|เชื่อมเว็บ|ลิงก์|ลิงค์)$/i.test(text);
        const linkLabel = isLink
          ? (inGroup ? await line.groupName?.(targetId) : await line.displayName?.(targetId)) || null
          : null;
        const reply = await handleMessage({ userId: senderId, targetId, inGroup, addressed, linkLabel, publicUrl,
          text, db, catalog, snapshot: snapshot(), now, selfCheck });
        if (reply) await line.reply(ev.replyToken, reply.text, targetId, reply.quick);
      } else if (ev.type === 'postback') {           // a tapped button from the alert picker
        const r = handlePostback({ data: ev.postback?.data || '', params: ev.postback?.params, db, catalog,
          snapshot: snapshot(), now, targetId, userId: senderId, inGroup, publicUrl });
        await line.reply(ev.replyToken, r.text, targetId, r.quick);
      }
    } catch (e) {
      log.error(`webhook: ${ev.type} in ${targetId} failed — ${e.message}`);
    }
  }
  return { status: 200, body: { ok: true } };
}
