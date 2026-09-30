// Pretend to be LINE: send a signed message event to the local webhook, then print what
// the bot replied (read from data/outbox.log — works in dry-run, i.e. before you have a
// real LINE token). Usage:
//   node scripts/fake-line.js "alert sat 18-21 2h"          (as user Udev)
//   node scripts/fake-line.js --user Ufriend "my alerts"
//   node scripts/fake-line.js --group Ctennis --user Ualice "alert sat 18-21 2h"   (a group chat)
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from '../lib/env.js';
import { signBody } from '../lib/line.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));
const secret = process.env.LINE_CHANNEL_SECRET;
if (!secret) { console.error('Set LINE_CHANNEL_SECRET in .env first (any made-up value works for dry-run).'); process.exit(1); }

const args = process.argv.slice(2);
const u = args.indexOf('--user');
const userId = u >= 0 ? args.splice(u, 2)[1] : 'Udev';
const g = args.indexOf('--group');
const groupId = g >= 0 ? args.splice(g, 2)[1] : null;
const text = args.join(' ') || 'help';
const outbox = join(ROOT, 'data', 'outbox.log');
const before = existsSync(outbox) ? statSync(outbox).size : 0;

const body = JSON.stringify({ destination: 'Ubot', events: [{
  type: 'message', replyToken: `rt-${Date.now()}`, timestamp: Date.now(),
  source: groupId ? { type: 'group', groupId, userId } : { type: 'user', userId }, message: { type: 'text', id: String(Date.now()), text },
}] });
const res = await fetch(`http://localhost:${process.env.PORT || 3000}/line/webhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Line-Signature': signBody(secret, body) }, body,
});
console.log(`${groupId ? `[group ${groupId}] ` : ''}${userId}: ${text}\nwebhook: ${res.status} ${await res.text()}\n`);
// slice in BYTES (Thai and emoji are multi-byte), then decode
if (existsSync(outbox)) console.log(readFileSync(outbox).subarray(before).toString('utf8').trim() || '(no reply written — is the server in live mode?)');
