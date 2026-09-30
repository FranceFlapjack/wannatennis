// LINE Messaging API: webhook signature check + reply/push.
// Without an access token the client runs DRY: every message it would send is appended
// to an outbox file instead, so the whole bot can be tried before the LINE channel exists.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const API = 'https://api.line.me/v2/bot/message';
const MAX_TEXT = 4900; // LINE's limit is 5000 characters per text message

/** X-Line-Signature = base64(HMAC-SHA256(channelSecret, raw request body)). */
export function verifySignature(secret, rawBody, signature) {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let given;
  try { given = Buffer.from(String(signature), 'base64'); } catch { return false; }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signBody(secret, rawBody) { // for the local test harness
  return createHmac('sha256', secret).update(rawBody).digest('base64');
}

const clip = (t) => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t);
const msg = (text, quick) => ({ type: 'text', text: clip(text), ...(quick?.length ? { quickReply: { items: quick.slice(0, 13) } } : {}) });

export function createLineClient({ token, outboxPath = null, fetchImpl = globalThis.fetch, log = console } = {}) {
  const dry = !token;
  async function send(kind, body, to) {
    if (dry) {
      const buttons = body.messages.flatMap((m) => m.quickReply?.items || []).map((i) => i.action.label);
      const entry = `--- ${new Date().toISOString()} ${kind.toUpperCase()} to ${to}\n${body.messages.map((m) => m.text).join('\n')}\n`
        + (buttons.length ? `[buttons: ${buttons.join(' | ')}]\n` : '');
      if (outboxPath) appendFileSync(outboxPath, `${entry}\n`);
      else log.log(entry);
      return { dry: true };
    }
    const res = await fetchImpl(`${API}/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`LINE ${kind} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return {};
  }
  // Names for labels (best effort — null in dry-run or on any error).
  async function getJson(path) {
    if (dry) return null;
    try {
      const res = await fetchImpl(`https://api.line.me/v2/bot/${path}`, { headers: { Authorization: `Bearer ${token}` } });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }
  return {
    dry,
    groupName: async (groupId) => (await getJson(`group/${encodeURIComponent(groupId)}/summary`))?.groupName ?? null,
    displayName: async (userId) => (await getJson(`profile/${encodeURIComponent(userId)}`))?.displayName ?? null,
    // quick = LINE quick-reply items (tap-able buttons under the message), optional
    reply: (replyToken, text, to = 'reply', quick = null) => send('reply', { replyToken, messages: [msg(text, quick)] }, to),
    push: (to, text, quick = null) => send('push', { to, messages: [msg(text, quick)] }, to),
  };
}
