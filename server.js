// Zero-dependency HTTP server: static frontend + a small JSON API.
// Run: node server.js   (then open http://localhost:3000)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { CATALOG } from './catalog.js';
import { poll, SNAPSHOT_PATH } from './lib/poll.js';
import { buildState, venueCard } from './lib/state.js';
import { ADAPTERS } from './lib/poll.js';
import { loadEnv } from './lib/env.js';
import { openDb } from './lib/db.js';
import { createLineClient } from './lib/line.js';
import { handleWebhook } from './lib/webhook.js';
import { runAlerts } from './lib/alerts.js';
import { updateHealth, runSelfCheck, maybeDailySelfCheck } from './lib/health.js';
import { handleApi, createLimiter } from './lib/webapi.js';
import { menu } from './lib/menu.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const PORT = process.env.PORT || 3000;
const POLL_EVERY_MS = 5 * 60 * 1000;

// LINE bot: secrets from .env (never committed). No token = dry-run into data/outbox.log.
loadEnv(join(HERE, '.env'));
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET || '';
mkdirSync(join(HERE, 'data'), { recursive: true });             // fresh checkout: no data/ yet
const db = openDb(join(HERE, 'data', 'app.db'));
const line = createLineClient({ token: process.env.LINE_CHANNEL_ACCESS_TOKEN || '', outboxPath: join(HERE, 'data', 'outbox.log') });
if (process.env.ADMIN_LINE_USER_ID) db.setAdmin(process.env.ADMIN_LINE_USER_ID);
const selfCheck = () => runSelfCheck({ catalog: CATALOG, adapters: ADAPTERS });
// for the website's "send to LINE" buttons and the bot's tap-to-link: bot's LINE ID (@xxxx), public site URL
const WEB_CONFIG = { botBasicId: process.env.LINE_BOT_BASIC_ID || null, publicUrl: process.env.PUBLIC_URL || null };
const limiter = createLimiter();

let snapshot = { generatedAt: null, dates: [], venues: {} };

// One poll at a time: a slow venue must not let the next timer tick start a second
// poll that reads the same baseline and races it to write the snapshot.
let inFlight = null;
function refresh() {
  if (inFlight) return inFlight;
  inFlight = poll()
    .then(async (s) => {
      snapshot = s;
      // after every fresh poll: tell people about just-opened courts, and watch our own health
      const a = await runAlerts({ db, catalog: CATALOG, snapshot: s, line, quick: menu({ publicUrl: WEB_CONFIG.publicUrl }) });
      if (a.users) console.log(`alerts: sent ${a.users} message(s) covering ${a.slots} slot(s)`);
      await updateHealth({ db, catalog: CATALOG, snapshot: s, line });
    })
    .catch((e) => console.error('poll failed', e.message))
    .finally(() => { inFlight = null; });
  return inFlight;
}

async function loadSnapshot() {
  try { snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8')); }
  catch { snapshot = await poll(); return; }
  // Saved data older than one poll cycle (server was stopped a while)? Serve it now,
  // refresh in the background so the next page load is current.
  if (Date.now() - Date.parse(snapshot.generatedAt || 0) > POLL_EVERY_MS) refresh();
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function serveStatic(res, urlPath) {
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/line/webhook') {
    if (req.method !== 'POST') return sendJson(res, { error: 'POST only' }, 405);
    let rawBody;
    try { rawBody = await readBody(req); } catch { return sendJson(res, { error: 'body too large' }, 413); }
    const r = await handleWebhook({ rawBody, signature: req.headers['x-line-signature'], secret: LINE_SECRET,
      db, line, catalog: CATALOG, snapshot: () => snapshot, selfCheck, publicUrl: WEB_CONFIG.publicUrl });
    return sendJson(res, r.body, r.status);
  }
  if (url.pathname === '/api/link' || url.pathname.startsWith('/api/alerts') || url.pathname === '/api/command' || url.pathname === '/api/config') {
    let body = null;
    if (req.method === 'POST') {
      try { body = JSON.parse((await readBody(req, 10_000)).toString('utf8') || '{}'); }
      catch { return sendJson(res, { error: 'Bad request' }, 400); }
    }
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
    // behind the Cloudflare tunnel every request comes from localhost; the real visitor is in this header
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';
    const r = await handleApi({ method: req.method, path: url.pathname, body, token, ip, db, catalog: CATALOG, snapshot, limiter, config: WEB_CONFIG });
    return sendJson(res, r.body, r.status);
  }
  if (url.pathname === '/api/venues') return sendJson(res, CATALOG.map((v) => venueCard(v, snapshot)));
  if (url.pathname === '/api/state') {
    const minHours = Math.min(6, Math.max(1, parseInt(url.searchParams.get('minHours') || '1', 10) || 1));
    const place = ['indoor', 'outdoor'].includes(url.searchParams.get('place')) ? url.searchParams.get('place') : 'all';
    return sendJson(res, buildState(snapshot, CATALOG, { minHours, place }));
  }
  if (url.pathname === '/api/health') return sendJson(res, { ok: true, generatedAt: snapshot.generatedAt });
  return serveStatic(res, url.pathname);
});

await loadSnapshot();
setInterval(refresh, POLL_EVERY_MS);
const daily = () => maybeDailySelfCheck({ db, catalog: CATALOG, adapters: ADAPTERS, line }).catch((e) => console.error('self-check failed', e.message));
setInterval(daily, 30 * 60 * 1000); daily();
server.listen(PORT, () => console.log(`tennis-finder on http://localhost:${PORT}  (data ${snapshot.generatedAt})  `
  + `LINE: ${LINE_SECRET ? (line.dry ? 'dry-run -> data/outbox.log' : 'live') : 'not configured'}`));
