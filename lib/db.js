// Durable state for the LINE bot, in Node's built-in SQLite (no npm install).
// Pass ':memory:' for tests.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,               -- LINE userId
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,             -- the TARGET chat: LINE userId (U…), groupId (C…) or roomId (R…)
  venues TEXT NOT NULL,              -- JSON array of venue ids ([] = every live venue)
  day_kind TEXT NOT NULL,            -- 'date' | 'weekly' | 'any'
  day_value TEXT,                    -- 'YYYY-MM-DD' | '0'..'6' (Sun..Sat) | NULL
  from_h INTEGER NOT NULL,           -- window start hour (inclusive)
  to_h INTEGER NOT NULL,             -- window end hour (exclusive: 18-21 = play by 21:00)
  min_hours INTEGER NOT NULL,
  place TEXT NOT NULL,               -- 'all' | 'indoor' | 'outdoor'
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS watches_user ON watches(user_id, active);
CREATE TABLE IF NOT EXISTS alerts_sent (   -- the dedupe: one alert per slot per person
  user_id TEXT NOT NULL, venue_id TEXT NOT NULL, court TEXT NOT NULL,
  date TEXT NOT NULL, hour INTEGER NOT NULL, sent_at TEXT NOT NULL,
  PRIMARY KEY (user_id, venue_id, court, date, hour)
);
CREATE TABLE IF NOT EXISTS venue_health (
  venue_id TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,  -- consecutive failed polls
  alerted INTEGER NOT NULL DEFAULT 0,
  last_ok TEXT, last_error TEXT,
  courts TEXT                        -- JSON list of court names last seen
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS link_codes (     -- "link" in LINE -> 6-digit code for the website
  code TEXT PRIMARY KEY, target_id TEXT NOT NULL, label TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS web_tokens (     -- a browser that entered a code may manage that chat's alerts
  token TEXT PRIMARY KEY, target_id TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL
);
`;
// columns added after the first release — added in place so existing data survives
const MIGRATIONS = [
  ['watches', 'origin', "TEXT NOT NULL DEFAULT 'line'"],   // 'line' | 'web'
  ['watches', 'created_by', 'TEXT'],                       // who set it (a userId), when known
];

export function openDb(file) {
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  for (const [table, col, def] of MIGRATIONS) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
  const q = (sql) => db.prepare(sql);
  const now = () => new Date().toISOString();
  const rowToWatch = (r) => r && {
    id: r.id, userId: r.user_id, venues: JSON.parse(r.venues), dayKind: r.day_kind, dayValue: r.day_value,
    fromH: r.from_h, toH: r.to_h, minHours: r.min_hours, place: r.place, createdAt: r.created_at,
    origin: r.origin, createdBy: r.created_by,
  };

  return {
    raw: db,
    // users
    touchUser(id) { q('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(id, now()); },
    isAdmin(id) { return !!q('SELECT is_admin FROM users WHERE id = ?').get(id)?.is_admin; },
    admins() { return q('SELECT id FROM users WHERE is_admin = 1').all().map((r) => r.id); },
    setAdmin(id) { this.touchUser(id); q('UPDATE users SET is_admin = 1 WHERE id = ?').run(id); },
    /** The first person to use the bot becomes admin (receives health alerts). */
    adminIfNone(id) { if (!this.admins().length) { this.setAdmin(id); return true; } return false; },

    // watches
    addWatch(targetId, w, { origin = 'line', createdBy = null } = {}) {
      const r = q(`INSERT INTO watches (user_id, venues, day_kind, day_value, from_h, to_h, min_hours, place, created_at, origin, created_by)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(targetId, JSON.stringify(w.venues), w.dayKind, w.dayValue ?? null, w.fromH, w.toH, w.minHours, w.place, now(), origin, createdBy);
      return Number(r.lastInsertRowid);
    },
    getWatch(id) { return rowToWatch(q('SELECT * FROM watches WHERE id = ? AND active = 1').get(id)); },
    /** A user's active watches, oldest first — their position is the number they see. */
    listWatches(userId) { return q('SELECT * FROM watches WHERE user_id = ? AND active = 1 ORDER BY id').all(userId).map(rowToWatch); },
    activeWatches() { return q('SELECT * FROM watches WHERE active = 1 ORDER BY id').all().map(rowToWatch); },
    cancelWatch(id) { q('UPDATE watches SET active = 0 WHERE id = ?').run(id); },
    cancelAll(userId) { return Number(q('UPDATE watches SET active = 0 WHERE user_id = ? AND active = 1').run(userId).changes); },
    /** One-off watches for a day that's over are done. */
    expireBefore(today) { return Number(q("UPDATE watches SET active = 0 WHERE active = 1 AND day_kind = 'date' AND day_value < ?").run(today).changes); },

    // alert dedupe
    wasSent(u, v, c, d, h) { return !!q('SELECT 1 FROM alerts_sent WHERE user_id=? AND venue_id=? AND court=? AND date=? AND hour=?').get(u, v, c, d, h); },
    markSent(u, v, c, d, h) { q('INSERT OR IGNORE INTO alerts_sent VALUES (?, ?, ?, ?, ?, ?)').run(u, v, c, d, h, now()); },
    pruneSentBefore(date) { q('DELETE FROM alerts_sent WHERE date < ?').run(date); },

    // venue health
    health(venueId) {
      const r = q('SELECT * FROM venue_health WHERE venue_id = ?').get(venueId);
      return r ? { ...r, courts: r.courts ? JSON.parse(r.courts) : null } : { venue_id: venueId, fails: 0, alerted: 0, last_ok: null, last_error: null, courts: null };
    },
    saveHealth(h) {
      q(`INSERT INTO venue_health (venue_id, fails, alerted, last_ok, last_error, courts) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(venue_id) DO UPDATE SET fails=excluded.fails, alerted=excluded.alerted,
           last_ok=excluded.last_ok, last_error=excluded.last_error, courts=excluded.courts`)
        .run(h.venue_id, h.fails, h.alerted ? 1 : 0, h.last_ok, h.last_error, h.courts ? JSON.stringify(h.courts) : null);
    },

    // website linking: a short-lived 6-digit code, then a long random browser token
    createLinkCode(targetId, label, ttlMs = 10 * 60_000) {
      q('DELETE FROM link_codes WHERE expires_at < ? OR target_id = ?').run(Date.now(), targetId);
      let code;
      do { code = String(randomInt(0, 1_000_000)).padStart(6, '0'); } while (q('SELECT 1 FROM link_codes WHERE code = ?').get(code));
      q('INSERT INTO link_codes VALUES (?, ?, ?, ?)').run(code, targetId, label, Date.now() + ttlMs);
      return code;
    },
    /** One-time: a code works once, then it's gone. */
    redeemLinkCode(code) {
      const r = q('SELECT * FROM link_codes WHERE code = ? AND expires_at >= ?').get(String(code), Date.now());
      if (!r) return null;
      q('DELETE FROM link_codes WHERE code = ?').run(r.code);
      const token = randomBytes(24).toString('base64url');
      q('INSERT INTO web_tokens VALUES (?, ?, ?, ?)').run(token, r.target_id, r.label, now());
      return { token, targetId: r.target_id, label: r.label };
    },
    tokenTarget(token) {
      const r = token && q('SELECT target_id, label FROM web_tokens WHERE token = ?').get(String(token));
      return r ? { targetId: r.target_id, label: r.label } : null;
    },
    deleteToken(token) { q('DELETE FROM web_tokens WHERE token = ?').run(String(token)); },
    deleteTargetTokens(targetId) { q('DELETE FROM web_tokens WHERE target_id = ?').run(targetId); },

    // misc
    get(key) { return q('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null; },
    set(key, value) { q('INSERT INTO kv VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)); },
  };
}
