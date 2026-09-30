// LINE command parser — English and Thai, rules only (no AI): a command either parses
// exactly or gets a short help reply, never a guess.
//   alert Sat 18-21 2h goat        แจ้งเตือน เสาร์ 18-21 2ชม โกท
//   alert every sun evening indoor แจ้งเตือน ทุกอาทิตย์ เย็น ในร่ม
//   alert tomorrow near sukhumvit  แจ้งเตือน พรุ่งนี้ แถว สุขุมวิท
//   my alerts / ดูแจ้งเตือน     cancel 2 / ยกเลิกแจ้งเตือน 2     cancel all / ยกเลิกทั้งหมด
//   help / วิธีใช้              link / เชื่อมเว็บ (code to manage alerts on the website)
//   (admin) status / สถานะ, selfcheck / ตรวจระบบ
// In a GROUP the bot must not chime in on normal chat: greetings aren't commands there,
// and a bare "cancel"/"ยกเลิก" (people say that about games!) needs "alert", a number or "all".
const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EN_DOW = /\b(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/i;
const EN_DOW_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const TH_DOW = [['พฤหัสบดี', 4], ['พฤหัส', 4], ['อาทิตย์', 0], ['จันทร์', 1], ['อังคาร', 2], ['พุธ', 3], ['ศุกร์', 5], ['เสาร์', 6]];
const PARTS = [ // named parts of the day -> [from, to)
  [/\bmorning\b|เช้า/i, 6, 12], [/\bafternoon\b|บ่าย/i, 12, 17],
  [/\bevening\b|\btonight\b|เย็น/i, 17, 22], [/\bnight\b|ค่ำ|กลางคืน|ดึก/i, 19, 24],
];

export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const dowOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
export const fmtDate = (date) => { const [, m, d] = date.split('-').map(Number); return `${DOW_NAMES[dowOf(date)]} ${d} ${MON[m - 1]}`; };
export const hh = (h) => `${String(h).padStart(2, '0')}:00`;
const isLive = (v) => v.source?.type && v.source.type !== 'manual';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Top-level command recognition. */
export function parseCommand(text, ctx) {
  const t = String(text || '').trim();
  const lower = t.toLowerCase();
  const inGroup = !!ctx?.inGroup;
  if (!t) return { type: inGroup ? 'unknown' : 'help' };
  if (/^(help|\?|menu|commands?)[!. ]*$/i.test(t) || /^(วิธีใช้|คำสั่ง|เมนู)$/.test(t)) return { type: 'help' };
  if (!inGroup && (/^(hi|hello|hey|start)[!. ]*$/i.test(t) || /^(ช่วยด้วย|ช่วย|สวัสดี\S*)$/.test(t))) return { type: 'help' };
  if (/^(link|link web|connect|เชื่อม|เชื่อมเว็บ|ลิงก์|ลิงค์)$/i.test(t)) return { type: 'link' };
  if (/^(web|website|site|เว็บ|เว็บไซต์)$/i.test(t)) return { type: 'web' };
  // "what's free": in groups only the exact button texts — people say "free tomorrow?" / "ว่างไหม"
  const free = t.match(/^(?:free|คอร์ทว่าง|หาคอร์ท)(?:\s+(.*)|$)/i);
  if (free && (!inGroup || /^(?:free|คอร์ทว่าง)\s*(today|tomorrow|วันนี้|พรุ่งนี้)?$/i.test(t))) {
    const w = parseAlert(free[1] || '', ctx);
    if (w.type !== 'alert') return w;
    if (w.dayKind !== 'date') { w.dayKind = 'date'; w.dayValue = ctx.clock.today; }   // "free" = a specific day, default today
    return { type: 'free', watch: w };
  }
  if (/^(status|สถานะ)$/i.test(t)) return { type: 'status' };
  if (/^(self-?check|ตรวจระบบ)$/i.test(t)) return { type: 'selfcheck' };
  if (/^(my alerts?|alerts|list|ดูแจ้งเตือน|แจ้งเตือนของฉัน|รายการแจ้งเตือน)$/i.test(t)) return { type: 'list' };
  const cancel = t.match(/^(?:cancel|stop|delete|ยกเลิกแจ้งเตือน|ยกเลิก|ลบ)\s*(?:alert\s*)?(all|ทั้งหมด|#?\d+)?\s*$/i);
  if (cancel) {
    const arg = cancel[1];
    if (inGroup && !arg && !/alert|แจ้งเตือน/i.test(t)) return { type: 'unknown' };
    if (!arg) return { type: 'cancel', which: null };
    if (/all|ทั้งหมด/i.test(arg)) return { type: 'cancel', which: 'all' };
    return { type: 'cancel', which: Number(arg.replace('#', '')) };
  }
  // start the tap-by-tap picker (also what rich menu / rich message "text" buttons send);
  // a bare "alert" means "help me set one", not "alert me about anything, any time"
  if (/^(new alert|set alert|set an alert|alert|notify|แจ้งเตือน|แจ้งเตือนใหม่|ตั้งแจ้งเตือน)$/i.test(t)) return { type: 'picker' };
  const alert = t.match(/^(?:alert|notify|watch|แจ้งเตือน|เตือน)\s*(.*)$/is);
  if (alert && !lower.startsWith('ดูแจ้งเตือน')) return parseAlert(alert[1], ctx);
  return { type: 'unknown' };
}

/** Parse the body of an alert command into a watch. ctx: { catalog, clock:{today,hour} }. */
export function parseAlert(body, { catalog, clock }) {
  let s = ` ${String(body || '').toLowerCase()} `;
  const w = { type: 'alert', venues: [], selfCheckNamed: [], dayKind: 'any', dayValue: null, fromH: 0, toH: 24, minHours: 1, place: 'all' };

  // explicit dates first, so "2026-10-03" or "3/10" can't be read as a time range
  let explicitDate = null;
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const dm = !iso && s.match(/(?:^|\s)(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s|$)/);
  if (iso) { explicitDate = `${iso[1]}-${iso[2]}-${iso[3]}`; s = s.replace(iso[0], ' '); }
  else if (dm) {
    const [d, m] = [Number(dm[1]), Number(dm[2])];
    if (m < 1 || m > 12 || d < 1 || d > 31) return { type: 'error', reason: 'I couldn’t read that date — try "3/10" (day/month).' };
    const y = Number(clock.today.slice(0, 4));
    explicitDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (explicitDate < clock.today) explicitDate = `${y + 1}${explicitDate.slice(4)}`; // "3/1" in December = next year
    s = s.replace(dm[0], ' ');
  }
  if (explicitDate && Number.isNaN(Date.parse(`${explicitDate}T00:00:00Z`))) return { type: 'error', reason: 'I couldn’t read that date.' };

  // duration next, so its number can't be read as an hour: "2h", "2 hrs", "2ชม", "2 ชั่วโมง"
  const dur = s.match(/(\d)\s*(?:h\b|hrs?\b|hours?\b|ชม\.?|ชั่วโมง)/i);
  if (dur) { w.minHours = Number(dur[1]); s = s.replace(dur[0], ' '); }
  if (w.minHours < 1 || w.minHours > 6) return { type: 'error', reason: 'Play time must be 1 to 6 hours (e.g. "2h").' };

  // place
  if (/\bindoor\b|ในร่ม/i.test(s)) w.place = 'indoor';
  else if (/\boutdoor\b|\boutside\b|กลางแจ้ง/i.test(s)) w.place = 'outdoor';

  // time window: "18-21", "18:00-21:00", "6-9pm", "6pm to 9pm", "18 ถึง 21"
  const tm = s.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|ถึง)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/i);
  if (tm) {
    const conv = (h, m, ap) => { h = Number(h); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; return h + (Number(m || 0) / 60); };
    const apEnd = tm[6]?.toLowerCase(), apStart = (tm[3] || (apEnd === 'pm' && Number(tm[1]) < Number(tm[4]) ? 'pm' : ''))?.toLowerCase();
    const from = conv(tm[1], tm[2], apStart), to0 = conv(tm[4], tm[5], apEnd);
    const to = to0 === 0 ? 24 : to0;
    w.fromH = Math.ceil(from); w.toH = Math.floor(to);
    s = s.replace(tm[0], ' ');
  } else {
    for (const [re, a, b] of PARTS) if (re.test(s)) { w.fromH = a; w.toH = b; break; }
  }
  if (!(w.fromH >= 0 && w.toH <= 24 && w.fromH < w.toH)) return { type: 'error', reason: 'I couldn’t read that time range — try "18-21".' };

  // day
  const every = /\bevery\b|\beach\b|ทุก/i.test(s);
  let dow = null;
  const en = s.match(EN_DOW);
  if (en) dow = EN_DOW_INDEX[en[1].slice(0, 3).toLowerCase()];
  else for (const [name, i] of TH_DOW) if (s.includes(name)) { dow = i; break; }
  if (explicitDate) { w.dayKind = 'date'; w.dayValue = explicitDate; }
  else if (/\btoday\b|\btonight\b|วันนี้|คืนนี้|เย็นนี้/i.test(s)) { w.dayKind = 'date'; w.dayValue = clock.today; }
  else if (/\btomorrow\b|พรุ่งนี้/i.test(s)) { w.dayKind = 'date'; w.dayValue = addDays(clock.today, 1); }
  else if (dow !== null && every) { w.dayKind = 'weekly'; w.dayValue = String(dow); }
  else if (dow !== null) {
    // the next such day; today only if a whole slot still fits in the window
    let ahead = (dow - dowOf(clock.today) + 7) % 7;
    if (ahead === 0 && Math.max(w.fromH, clock.hour + 1) + w.minHours > w.toH) ahead = 7;
    w.dayKind = 'date'; w.dayValue = addDays(clock.today, ahead);
  }
  // (a named weekday that's today but too late already rolled over to next week above)

  // venues: longest alias first, and a matched stretch of text can't be reused
  // (so "crystal g" is Crystal Sports G, not also Crystal Sports)
  const candidates = [];
  for (const v of catalog) {
    for (const a of new Set([v.id, v.name, v.nameTh, ...(v.aliases || [])].filter(Boolean).map((x) => x.toLowerCase()))) {
      candidates.push({ v, a });
    }
  }
  candidates.sort((x, y) => y.a.length - x.a.length);
  const used = [];
  const named = new Set();
  for (const { v, a } of candidates) {
    const re = /^[\x00-\x7f]+$/.test(a) ? new RegExp(`(^|[^a-z0-9])${escapeRe(a)}(?=[^a-z0-9]|$)`, 'i') : new RegExp(escapeRe(a));
    const m = s.match(re);
    if (!m) continue;
    const start = m.index + (m[1] ? m[1].length : 0), end = start + a.length;
    if (used.some(([x, y]) => start < y && end > x)) continue;
    used.push([start, end]);
    named.add(v);
  }
  // "near X" / "แถว X": match the venue area text
  const near = s.match(/(?:\bnear\b|\baround\b|แถว|ย่าน)\s*([^\s,]+(?:\s+\d+(?:\/\d+)?)?)/i);
  if (near && near[1].length >= 2) {
    const term = near[1].trim();
    for (const v of catalog) if (`${v.area} ${v.areaTh || ''}`.toLowerCase().includes(term)) named.add(v);
  }
  for (const v of named) (isLive(v) ? w.venues : w.selfCheckNamed).push(v.id);
  if (named.size && !w.venues.length) return { type: 'error', reason: 'selfcheck-only', venues: w.selfCheckNamed };
  const why = checkWatch(w, { catalog, clock });
  if (why) return { type: 'error', reason: why };
  if (near && !named.size) return { type: 'error', reason: `I don’t know any courts near "${near[1].trim()}".` };
  return w;
}

/**
 * The rules every alert must satisfy — used by the chat parser AND the website, so the
 * two can never disagree. Returns a reason string, or null if the watch is fine.
 */
export function checkWatch(w, { catalog, clock }) {
  const int = (x) => Number.isInteger(x);
  if (!int(w.minHours) || w.minHours < 1 || w.minHours > 6) return 'Play time must be 1 to 6 hours (e.g. "2h").';
  if (!int(w.fromH) || !int(w.toH) || w.fromH < 0 || w.toH > 24 || w.fromH >= w.toH) return 'That time range doesn’t work — try e.g. 18–21.';
  if (w.toH - w.fromH < w.minHours) {
    return `${hh(w.fromH)}–${hh(w.toH)} is shorter than ${w.minHours}h — widen the time or shorten the play time.`;
  }
  if (!['all', 'indoor', 'outdoor'].includes(w.place)) return 'Court type must be all, indoor or outdoor.';
  if (!Array.isArray(w.venues) || w.venues.some((id) => !catalog.some((v) => v.id === id && isLive(v)))) {
    return 'Alerts only work for courts that are checked live.';
  }
  if (w.dayKind === 'weekly') { if (!/^[0-6]$/.test(String(w.dayValue))) return 'Unknown weekday.'; }
  else if (w.dayKind === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(w.dayValue)) || Number.isNaN(Date.parse(`${w.dayValue}T00:00:00Z`))) return 'I couldn’t read that date.';
    if (w.dayValue < clock.today) return `${fmtDate(w.dayValue)} has already passed.`;
    if (w.dayValue === clock.today && Math.max(w.fromH, clock.hour + 1) + w.minHours > w.toH) {
      return `It's too late today for ${w.minHours}h between ${hh(w.fromH)} and ${hh(w.toH)} — try another day.`;
    }
  } else if (w.dayKind !== 'any') return 'Unknown day.';
  return null;
}

/**
 * The chat command that means exactly this watch — the website's "send to LINE" buttons
 * put it in the message box. Uses venue ids (always recognised) and d/m dates.
 */
export function watchToCommand(w) {
  const parts = ['alert'];
  if (w.dayKind === 'date') { const [, m, d] = w.dayValue.split('-').map(Number); parts.push(`${d}/${m}`); }
  else if (w.dayKind === 'weekly') parts.push(`every ${DOW_NAMES[Number(w.dayValue)]}`);
  if (!(w.fromH === 0 && w.toH === 24)) parts.push(`${w.fromH}-${w.toH}`);
  parts.push(`${w.minHours}h`);
  if (w.place !== 'all') parts.push(w.place);
  parts.push(...w.venues);
  return parts.join(' ');
}

/** True if `text` parses back to the same watch (guards the website's generated commands). */
export function roundTrips(w, text, ctx) {
  const r = parseCommand(text, ctx);
  if (r.type !== 'alert') return false;
  const key = (x) => JSON.stringify([x.dayKind, x.dayValue ?? null, x.fromH, x.toH, x.minHours, x.place, [...x.venues].sort()]);
  return key(r) === key({ ...w, dayValue: w.dayKind === 'any' ? null : w.dayValue });
}

/** "Sat 3 Oct · 18:00–21:00 · 2h · Beat, GOAT57 · indoor" */
export function describeWatch(w, catalog) {
  const day = w.dayKind === 'date' ? fmtDate(w.dayValue)
    : w.dayKind === 'weekly' ? `Every ${DOW_NAMES[Number(w.dayValue)]}` : 'Any day this week';
  const time = w.fromH === 0 && w.toH === 24 ? 'any time' : `${hh(w.fromH)}–${hh(w.toH)}`;
  const names = w.venues.length ? w.venues.map((id) => catalog.find((v) => v.id === id)?.name || id).join(', ') : 'all live courts';
  return [day, time, `${w.minHours}h`, names, w.place === 'all' ? null : w.place].filter(Boolean).join(' · ');
}

/** Watch fields from a web form / request body (numbers/strings coerced; validated by checkWatch). */
export function watchFrom(body) {
  const w = {
    venues: Array.isArray(body?.venues) ? body.venues.map(String) : [],
    dayKind: String(body?.dayKind ?? ''), dayValue: body?.dayValue == null ? null : String(body.dayValue),
    fromH: Number(body?.fromH), toH: Number(body?.toH), minHours: Number(body?.minHours), place: String(body?.place ?? 'all'),
  };
  if (w.dayKind === 'any') w.dayValue = null;
  return w;
}

/**
 * The website's "send to LINE" buttons: the command text plus the two LINE links.
 * Pure, so the server (/api/command) and the static site (in the browser) share it.
 * Returns { error } or { text, summary, lineUrl, shareUrl }.
 */
export function lineCommand(body, { catalog, clock, botBasicId = null }) {
  const w = watchFrom(body);
  const why = checkWatch(w, { catalog, clock });
  if (why) return { error: why };
  const text = watchToCommand(w);
  if (!roundTrips(w, text, { catalog, clock })) return { error: 'Could not build the LINE message for this alert.' };
  const enc = encodeURIComponent(text);
  return {
    text, summary: describeWatch(w, catalog),
    // opens the chat with the bot, message typed in — needs the bot's LINE ID (@xxxx)
    lineUrl: botBasicId ? `https://line.me/R/oaMessage/${encodeURIComponent(botBasicId)}/?${enc}` : null,
    // LINE's own "share to…" picker: choose the group, the bot there reads the command
    shareUrl: `https://line.me/R/share?text=${enc}`,
  };
}
