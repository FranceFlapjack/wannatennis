// "🔔 LINE alerts" panel (first draft).
//  1. Build an alert here, then "Alert me in LINE" / "Alert my group" opens LINE with the
//     command already typed — you tap Send. No linking: LINE itself proves who sent it.
//  2. Optional: see & cancel alerts here. Send "link" to the bot, tap the link it sends
//     (opens this site already linked). A 6-digit code box stays as a fallback.
//     Needs the server — the static site (GitHub Pages) shows a note instead.
import { STATIC, getVenues, getConfig, buildCommand } from './data.js';
const $ = (s, r = document) => r.querySelector(s);
const el = (t, cls, txt) => { const e = document.createElement(t); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const hh = (h) => `${String(h).padStart(2, '0')}:00`;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const KEY = 'wt.lineLinks';

const store = {
  get() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } },
  set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode: works until reload */ } },
};
let links = store.get();
let current = links[0]?.token || null;
let config = { botBasicId: null, addFriendUrl: null };
let venues = [];
let builder = null;       // reads the form
let flash = null;         // one-off message shown at the top

async function api(method, path, body, token) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}
const pageState = () => window.__wt || {};

function select(options, value) {
  const s = el('select');
  for (const [v, label] of options) { const o = el('option', null, label); o.value = v; if (String(v) === String(value)) o.selected = true; s.append(o); }
  return s;
}
function seg(options, value) {
  const wrap = el('div', 'seg'); let val = value;
  for (const [v, label] of options) {
    const b = el('button', v === value ? 'on' : '', label); b.type = 'button';
    b.onclick = () => { val = v; [...wrap.children].forEach((x) => x.classList.toggle('on', x === b)); };
    wrap.append(b);
  }
  return { wrap, get: () => val };
}

const LINE_ICON = '<svg class="line-ico" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#06C755"/><path fill="#fff" d="M12 5.3c-4.2 0-7.6 2.7-7.6 6 0 3 2.7 5.5 6.4 5.9.3.1.5.3.4.7l-.2 1.1c0 .3.2.5.5.3 2-1.2 5.4-3.6 6.9-5.4.8-.9 1.2-1.9 1.2-2.6 0-3.3-3.4-6-7.6-6z"/></svg>';

// Courts dropdown: "All live courts" or tick one or more. Picking a court unticks All;
// unticking the last court goes back to All.
function courtPicker(list) {
  const wrap = el('div', 'ms');
  const btn = el('button', 'ms-btn'); btn.type = 'button';
  const panel = el('div', 'ms-panel'); panel.hidden = true;
  const opt = (label, cls) => { const l = el('label', `ms-opt ${cls || ''}`); const cb = el('input'); cb.type = 'checkbox'; l.append(cb, document.createTextNode(label)); return [l, cb]; };
  const [allL, allCb] = opt('All live courts', 'ms-all'); allCb.checked = true;
  const boxes = list.map((v) => { const [l, cb] = opt(v.name); cb.value = v.id; panel.append(l); return cb; });
  panel.prepend(allL);
  const label = () => {
    const picked = boxes.filter((b) => b.checked);
    btn.textContent = picked.length ? picked.map((b) => list.find((v) => v.id === b.value).name).join(', ') : 'All live courts';
  };
  allCb.onchange = () => { if (allCb.checked) boxes.forEach((b) => { b.checked = false; }); else allCb.checked = true; label(); };
  boxes.forEach((b) => { b.onchange = () => { allCb.checked = !boxes.some((x) => x.checked); label(); }; });
  btn.onclick = () => { panel.hidden = !panel.hidden; };
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) panel.hidden = true; });
  label(); wrap.append(btn, panel);
  return { wrap, get: () => boxes.filter((b) => b.checked).map((b) => b.value) };
}

// ① Add the bot as a friend — LINE only delivers alert (push) messages to friends.
function renderAddFriend(box) {
  const step = el('div', 'al-step');
  step.append(el('h3', 'al-h', '① Add Wanna Tennis on LINE (once)'),
    el('div', 'al-sub', 'LINE only delivers alerts to people who added the bot as a friend.'));
  if (STATIC) step.append(el('div', 'al-sub al-beta', 'Beta: the bot is only online some of the time for now. If it doesn’t answer, try again later.'));
  if (!config.addFriendUrl) { step.append(el('div', 'al-sub', '(Available once the bot’s LINE ID is configured.)')); box.append(step); return; }
  const row = el('div', 'al-friend');
  const add = el('a', 'btn al-line'); add.href = config.addFriendUrl; add.target = '_blank'; add.rel = 'noopener';
  add.innerHTML = `${LINE_ICON}<span>Add friend</span>`;
  row.append(add);
  if (window.qrcode) {                  // on a computer: scan with your phone instead
    const qr = window.qrcode(0, 'M'); qr.addData(config.addFriendUrl); qr.make();
    const fig = el('figure', 'al-qr'); fig.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    fig.append(el('figcaption', null, 'On a computer? Scan with your phone.'));
    row.append(fig);
  }
  step.append(row); box.append(step);
}

function renderBuilder(box) {
  const ps = pageState();
  const days = (ps.data?.dates || []).map((d) => [`date:${d.date}`, `${d.dow} ${d.day} ${d.mon}${d.today ? ' (today)' : ''}`]);
  const day = select([...days, ...DOW.map((n, i) => [`weekly:${i}`, `Every ${n}`]), ['any:', 'Any day']], `date:${ps.date || ''}`);
  const from = select([...Array(19)].map((_, i) => [i + 5, hh(i + 5)]), 18);
  const to = select([...Array(19)].map((_, i) => [i + 6, hh(i + 6)]), 21);
  const hours = seg([[1, '1 hr'], [2, '2 hrs'], [3, '3 hrs']], ps.minHours || 1);
  const place = seg([['all', 'All'], ['indoor', 'Indoor'], ['outdoor', 'Outdoor']], ps.place || 'all');
  const courts = courtPicker(venues);
  const field = (label, node) => { const f = el('label', 'al-field'); f.append(el('span', null, label), node); return f; };
  const time = el('div', 'al-time'); time.append(from, el('span', null, 'to'), to);
  const grid = el('div', 'al-grid');
  const courtsField = el('div', 'al-field al-wide'); courtsField.append(el('span', null, 'Courts'), courts.wrap);
  grid.append(field('Day', day), field('Time window', time), field('Play for', hours.wrap), field('Court type', place.wrap), courtsField);
  box.append(el('h3', 'al-h', '② Choose what to be alerted about'), grid);

  builder = () => {
    const [kind, value] = day.value.split(':');
    return { dayKind: kind, dayValue: value || null, fromH: Number(from.value), toH: Number(to.value), minHours: hours.get(), place: place.get(),
      venues: courts.get() };
  };

  const msg = el('div', 'al-msg');
  const go = async (which) => {
    msg.textContent = ''; msg.className = 'al-msg';
    const r = await buildCommand(builder());
    if (r.error) { msg.className = 'al-msg err'; msg.textContent = r.error; return; }
    const url = which === 'me' ? r.lineUrl : r.shareUrl;
    msg.textContent = `LINE will open with: “${r.text}” — just tap Send.`;
    window.location.href = url;          // opens the LINE app (or line.me on a computer)
  };
  const row = el('div', 'al-send');
  const me = el('button', 'btn al-line'); me.innerHTML = `${LINE_ICON}<span>Alert me in LINE</span>`;
  const group = el('button', 'btn al-line', '👥 Alert my group');
  me.onclick = () => go('me'); group.onclick = () => go('group');
  if (!config.botBasicId) { me.disabled = true; me.title = 'Needs the bot\'s LINE ID (LINE_BOT_BASIC_ID) — set up after the LINE account exists'; }
  row.style.marginTop = '12px';
  row.append(me, group);
  box.append(row, el('div', 'al-sub', '“Alert my group” lets you pick your tennis group in LINE — the alert then goes to everyone there.'), msg);
  if (!config.botBasicId) box.append(el('div', 'al-sub', '(“Alert me” switches on once the bot’s LINE ID is configured.)'));
}

async function renderLinked(box) {
  const wrap = el('div', 'al-linked');
  box.append(wrap);
  if (STATIC) {
    wrap.append(el('div', 'al-sub', 'To see or cancel your alerts, send "my alerts" to the bot (or tap My alerts in its menu).'));
    return;
  }
  if (!links.length) {
    wrap.append(el('div', 'al-sub', 'Want to see and cancel alerts here too? Send "link" to the bot (in your chat or your group) and tap the link it sends.'));
    const row = el('div', 'al-linkrow');
    const input = el('input'); input.inputMode = 'numeric'; input.maxLength = 6; input.placeholder = 'or enter the 6-digit code'; input.autocomplete = 'one-time-code';
    const go = el('button', 'btn', 'Link');
    const msg = el('div', 'al-msg');
    go.onclick = () => redeem(input.value, msg);
    input.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
    row.append(input, go); wrap.append(row, msg);
    return;
  }
  wrap.append(el('h3', 'al-h', 'Your alerts'));
  const tabs = el('div', 'al-tabs');
  for (const l of links) {
    const b = el('button', `al-tab${l.token === current ? ' on' : ''}`, l.label);
    b.onclick = () => { current = l.token; render(); };
    tabs.append(b);
  }
  wrap.append(tabs);
  const list = el('div', 'al-list', 'Loading…'); wrap.append(list);
  const r = await api('GET', '/api/alerts', null, current);
  if (r.status === 401) {           // bot removed from that group, or unlinked elsewhere
    links = links.filter((l) => l.token !== current); store.set(links); current = links[0]?.token || null; return render();
  }
  list.innerHTML = '';
  if (!r.ok) { list.textContent = r.data.error || 'Could not load alerts.'; return; }
  if (!r.data.alerts.length) list.append(el('p', 'al-empty', 'No alerts yet for this chat.'));
  for (const a of r.data.alerts) {
    const row = el('div', 'al-item'); row.append(el('span', 'al-text', `${a.n}. ${a.text}`));
    const x = el('button', 'al-x', '✕'); x.title = 'Cancel this alert';
    x.onclick = async () => { x.disabled = true; await api('DELETE', `/api/alerts/${a.id}`, null, current); render(); };
    row.append(x); list.append(row);
  }
  const label = links.find((l) => l.token === current)?.label || 'this chat';
  const add = el('button', 'btn al-direct', `＋ Add the alert above to “${label}” directly`);
  add.onclick = async () => {
    const res = await api('POST', '/api/alerts', builder(), current);
    flash = res.ok
      ? { ok: true, text: `✅ Alert ${res.data.alert.n} set for “${label}”.`
          + (!res.data.freeNow.length && res.data.shorterFree?.length ? ' Nothing back-to-back yet — single free hours:' : ''),
        free: res.data.freeNow.length ? res.data.freeNow : res.data.shorterFree }
      : { ok: false, text: res.data.error || 'Could not create the alert.' };
    render();
  };
  const unlink = el('button', 'al-link-btn', 'Unlink this browser from this chat');
  unlink.onclick = async () => { await api('DELETE', '/api/link', null, current); links = links.filter((l) => l.token !== current); store.set(links); current = links[0]?.token || null; render(); };
  wrap.append(add, unlink);
}

async function redeem(code, msgEl, rerender = true) {
  const r = await api('POST', '/api/link', { code });
  if (!r.ok) { if (msgEl) { msgEl.className = 'al-msg err'; msgEl.textContent = r.data.error || 'Could not link.'; } return false; }
  links = [...links.filter((l) => l.token !== r.data.token), { token: r.data.token, label: r.data.label }];
  store.set(links); current = r.data.token;
  flash = { ok: true, text: `🔗 Linked to “${r.data.label}” — you can see and cancel its alerts here.` };
  if (rerender) render();
  return true;
}

async function render() {
  // the day list comes from the main page's data — give it a moment if we got here first
  for (let i = 0; i < 40 && !pageState().data; i++) await new Promise((r) => setTimeout(r, 100));
  const box = $('#alerts-body'); box.innerHTML = '';
  if (flash) {
    const f = el('div', `al-msg ${flash.ok ? 'ok' : 'err'}`); f.append(el('div', null, flash.text));
    for (const s of flash.free || []) {
      const a = el('a', 'al-free', `${s.date} · ${s.venue} · ${s.time} · ${s.courts.join(', ')}`);
      a.href = s.url; a.target = '_blank'; a.rel = 'noopener'; f.append(a);
    }
    box.append(f); flash = null;
  }
  renderAddFriend(box);
  box.append(el('hr', 'al-rule'));
  renderBuilder(box);
  box.append(el('hr', 'al-rule'));
  await renderLinked(box);
}

async function init() {
  const [c, v] = await Promise.all([getConfig(), getVenues()]);
  config = c || config;
  venues = v.filter((x) => x.live).map((x) => ({ id: x.id, name: x.name }));
  // Arrived from the bot's tap-to-link? Link, then take the code out of the address bar.
  const params = new URLSearchParams(location.search);
  const code = STATIC ? null : params.get('link');
  $('#alertswrap').addEventListener('toggle', function () { if (this.open) render(); });
  if (code) {
    history.replaceState(null, '', location.pathname);
    if (!(await redeem(code, null, false))) flash = { ok: false, text: 'That link has expired or was already used — send "link" to the bot again.' };
    $('#alertswrap').open = true;        // opening it renders once, flash included
  }
}
init();
