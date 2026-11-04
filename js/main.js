import { Table, tileHTML, roundName } from './ui.js';
import { codeForUrl, parseTableInput, scanTables } from './lan.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const FAKE = params.has('fake');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const prefs = {
  sound: store.get('minimaj-sound', '0') === '1', // off unless the player turns it on
  mankanji: store.get('minimaj-mankanji', '1') === '1',
};
const applyManNumerals = () => document.documentElement.classList.toggle('man-arabic', !prefs.mankanji);
applyManNumerals();

let net = null;       // session module (js/net.js or js/dev-fake.js)
let info = null;      // /info.json when served by the minimaj app, else null
let qr = null;        // js/qr.js module, if available
let session = null;
let screen = 'home';
let table = null;
let view = null;
let prev = null;      // previous view (for sounds)
const ui = { riichiMode: false, selected: null, autoKey: null };
let pointerType = 'mouse';

/* ---------------- toast / banner ---------------- */

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function banner(text) {
  const el = $('banner');
  el.hidden = !text;
  if (text) el.textContent = text;
}

/* ---------------- sound (off by default) ---------------- */

let actx = null;
function audio() {
  if (!prefs.sound) return null;
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { actx = new AC(); } catch { return null; }
  }
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => { audio(); }, { capture: true, passive: true });

function tone(freq, t0, dur, { type = 'sine', vol = 0.18, to = null } = {}) {
  const c = audio();
  if (!c || c.state !== 'running') return;
  const t = c.currentTime + t0;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
const sfx = {
  discard: () => { tone(260, 0, 0.09, { to: 110, vol: 0.22 }); tone(1500, 0, 0.025, { type: 'triangle', vol: 0.04 }); },
  call: () => { tone(660, 0, 0.09, { type: 'triangle' }); tone(990, 0.07, 0.12, { type: 'triangle' }); },
  riichi: () => { tone(784, 0, 0.1, { type: 'triangle' }); tone(1175, 0.08, 0.18, { type: 'triangle' }); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.08, 0.45, { type: 'triangle', vol: 0.14 })),
  draw: () => { tone(440, 0, 0.2, { type: 'triangle', vol: 0.1 }); tone(330, 0.12, 0.3, { type: 'triangle', vol: 0.1 }); },
  tick: () => tone(880, 0, 0.05, { type: 'triangle', vol: 0.08 }),
};

/* ---------------- settings menu ---------------- */

const ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/></svg>';

function setupMenu() {
  const btn = $('menubtn');
  btn.innerHTML = ICON;
  btn.onclick = (e) => { e.stopPropagation(); toggleMenu(); };
  document.addEventListener('click', (e) => { if (!$('menu').hidden && !e.target.closest('#menu')) $('menu').hidden = true; });
}

function toggleMenu(force) {
  const m = $('menu');
  const show = force ?? m.hidden;
  if (!show) { m.hidden = true; return; }
  const sw = (k, label) => `<button data-pref="${k}" class="${prefs[k] ? 'on' : ''}">${label}<span class="sw"></span></button>`;
  m.innerHTML = sw('sound', 'Sound')
    + `<button data-menu="mannum">Man numbers<span class="val">${prefs.mankanji ? '一二三' : '1 2 3'}</span></button>`
    + (session ? `<hr><button class="leave" data-menu="leave">Leave table</button>` : '');
  m.hidden = false;
  m.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.pref) {
      const k = b.dataset.pref;
      prefs[k] = !prefs[k];
      store.set(`minimaj-${k}`, prefs[k] ? '1' : '0');
      b.classList.toggle('on', prefs[k]);
      if (k === 'sound' && prefs.sound) sfx.tick();
    } else if (b.dataset.menu === 'mannum') {
      prefs.mankanji = !prefs.mankanji;
      store.set('minimaj-mankanji', prefs.mankanji ? '1' : '0');
      b.querySelector('.val').textContent = prefs.mankanji ? '一二三' : '1 2 3';
      applyManNumerals();
    } else if (b.dataset.menu === 'leave') { m.hidden = true; leave(); }
  };
}

/* ---------------- screens ---------------- */

function setScreen(name, cls = 'home') {
  screen = name;
  table = null;
  if (name !== 'game') { view = null; prev = null; }
  app.className = cls;
  app.onclick = null;
  $('menubtn').hidden = !(name === 'lobby' || name === 'game');
  $('menu').hidden = true;
  document.title = 'minimaj';
}

const logo = () => `<h1 class="logo"><span class="tiles">${tileHTML(4 * 33)}${tileHTML(52)}${tileHTML(4 * 27)}</span>minimaj</h1>`;

function endSession() {
  if (session) { try { session.close(); } catch { /* ignore */ } }
  session = null;
  banner('');
}

// Remember (per tab) that we were at a table, so a reload rejoins automatically.
const AUTO_KEY = 'minimaj-auto';
const auto = {
  save(opts) { try { const { info: _i, ...o } = opts; sessionStorage.setItem(AUTO_KEY, JSON.stringify(o)); } catch { /* ignore */ } },
  clear() { try { sessionStorage.removeItem(AUTO_KEY); } catch { /* ignore */ } },
  load() { try { return JSON.parse(sessionStorage.getItem(AUTO_KEY) || 'null'); } catch { return null; } },
};

function leave() {
  auto.clear();
  endSession();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  showHome();
}

function getName(el) {
  const n = el.value.trim().slice(0, 16) || 'Player';
  store.set('minimaj-name', n);
  return n;
}

function showHome(err) {
  endSession();
  setScreen('home');
  const name = esc(store.get('minimaj-name', ''));
  const errHTML = err ? `<p class="err">${esc(err)}</p>` : '';
  const nameField = `<label>Your name<input id="name" maxlength="16" autocomplete="nickname" value="${name}" placeholder="Name" enterkeyhint="go"></label>`;
  if (info) {
    // On your own device you can host your table or join a friend's table.
    const own = !!info.hostOk;
    app.innerHTML = `<div class="card split${own ? ' friend' : ''}"><div class="c1">${logo()}
      <p class="muted">Riichi mahjong${own ? '' : ' at this table'}. Up to four players — empty seats are played by the computer.</p>
      ${own ? '' : '<span class="pill-note">Joining a friend\'s table</span>'}</div>
      <div class="c2">${nameField}
      <button id="join" class="act hot wide">${own ? 'Host a table' : 'Join table'}</button>
      ${errHTML}</div>
      ${own ? `<div class="c3"><div class="or">or join a friend's table</div>
      <ul class="nearby" id="nearby"><li class="muted small" id="scanmsg">Looking for tables nearby…</li></ul>
      <div class="joinrow">
        <input id="tcode" placeholder="Table code or address" autocapitalize="characters" autocomplete="off" spellcheck="false" enterkeyhint="go" aria-label="Table code or address">
        <button id="joint" class="act">Join</button>
      </div></div>` : ''}
      ${howTo()}
    </div>`;
    const nameEl = $('name');
    const go = () => connect({ mode: 'lan', name: getName(nameEl), info });
    $('join').onclick = go;
    nameEl.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    if (own) setupJoinFriend(nameEl);
    if (!FAKE) nameEl.focus();
    return;
  }
  const code = net && net.normCode ? net.normCode(location.hash.slice(1)) : '';
  app.innerHTML = `<div class="card split"><div class="c1">${logo()}
    <p class="muted">Riichi mahjong with friends, peer-to-peer. Empty seats are played by the computer.</p></div>
    <div class="c2">${nameField}
    <button id="create" class="act hot wide">Create room</button>
    <div class="or">or join a friend</div>
    <div class="joinrow">
      <input id="code" maxlength="5" placeholder="CODE" value="${esc(code)}" autocapitalize="characters" autocomplete="off" spellcheck="false" enterkeyhint="go">
      <button id="joinc" class="act">Join</button>
    </div>
    ${errHTML}</div>
    ${howTo()}
  </div>`;
  const nameEl = $('name');
  const codeEl = $('code');
  $('create').onclick = () => connect({ mode: 'online', name: getName(nameEl), create: true });
  const join = () => {
    const c = net.normCode(codeEl.value);
    if (c.length !== 5) { codeEl.focus(); toast('Enter the 5-character room code'); return; }
    connect({ mode: 'online', name: getName(nameEl), code: c });
  };
  $('joinc').onclick = join;
  codeEl.onkeydown = (e) => { if (e.key === 'Enter') join(); };
  codeEl.oninput = () => { codeEl.value = net.normCode(codeEl.value); };
  if (!FAKE) (code && !nameEl.value ? nameEl : code ? $('joinc') : nameEl).focus();
}

// Joining another minimaj app on the same Wi-Fi: go to that table's page and
// carry the name along (each table is a different origin, so localStorage isn't shared).
function goToTable(url, nameEl) {
  const name = getName(nameEl);
  location.href = `${url}/?n=${encodeURIComponent(name)}&go=1`;
}

let scanRun = 0;
function setupJoinFriend(nameEl) {
  const codeEl = $('tcode');
  const join = () => {
    const url = parseTableInput(codeEl.value);
    if (!url) { codeEl.focus(); toast('Enter the table code shown in your friend\'s lobby (like AAJZ)'); return; }
    goToTable(url, nameEl);
  };
  $('joint').onclick = join;
  codeEl.onkeydown = (e) => { if (e.key === 'Enter') join(); };

  const list = $('nearby');
  const run = ++scanRun;
  const seen = new Set();
  scanTables(info.lanUrls || [], ({ url, code, info: ti }) => {
    if (run !== scanRun || !list.isConnected || seen.has(url)) return;
    seen.add(url);
    const t = ti.table || {};
    const who = t.host ? `${esc(t.host)}'s table` : 'Table';
    const detail = [t.players ? `${t.players} player${t.players === 1 ? '' : 's'}` : 'empty', t.playing ? 'playing' : 'in lobby'].join(' · ');
    const li = document.createElement('li');
    li.innerHTML = `<button class="act" data-url="${esc(url)}"><span class="nm">${who}<small>${detail}${code ? ` · ${esc(code)}` : ''}</small></span><span class="go">Join</span></button>`;
    li.querySelector('button').onclick = () => goToTable(url, nameEl);
    const msg = $('scanmsg');
    if (msg) msg.remove();
    if (list.children.length < 3) list.appendChild(li);
  }).then(() => {
    const msg = $('scanmsg');
    if (run === scanRun && msg) msg.textContent = (info.lanUrls || []).length ? 'No tables found nearby — ask for the table code.' : 'Not on Wi-Fi — connect to join friends.';
  });
}

const howTo = () => `<details><summary>How to play</summary>
  <p>Tap a tile to lift it, tap again to discard (click once with a mouse). Buttons for Chi, Pon, Kan, Ron, Tsumo and Riichi appear when you can use them.
  After riichi your draws are discarded for you. The bar shows your waits when you are tenpai.</p></details>`;

function showConnecting(text) {
  setScreen('connecting');
  app.innerHTML = `<div class="card">${logo()}<div class="spin"></div><p class="muted" style="text-align:center">${esc(text)}</p>
    <button class="act ghost wide" id="cancel">Cancel</button></div>`;
  $('cancel').onclick = leave;
}

function showStopped() {
  endSession();
  setScreen('stopped');
  app.innerHTML = `<div class="card">${logo()}<h2>Server stopped</h2>
    <p class="muted">The minimaj table has been shut down. You can close this window.</p></div>`;
}

function connect(opts) {
  if (!net || !net.createSession) { showHome('The networking module did not load. Please reload the page.'); return; }
  showConnecting(opts.mode === 'lan' ? 'Joining the table…' : opts.create ? 'Opening a room…' : `Connecting to room ${opts.code}…`);
  try {
    session = net.createSession(opts, handlers);
    auto.save(opts);
  } catch (e) {
    console.error(e);
    showHome(e.message || 'Could not connect');
  }
}

const handlers = {
  onLobby: (l) => { if (session) showLobby(l); },
  onView: (v) => { if (session) renderGame(v); },
  onError: (msg, fatal) => { if (fatal) { auto.clear(); showHome(msg); } else toast(msg); },
  onStatus: (text) => { if (text) toast(text); },
  onConn: (state) => {
    if (state === 'reconnecting') banner('Reconnecting…');
    else if (state === 'connecting' && (screen === 'lobby' || screen === 'game')) banner('Connecting…');
    else if (state === 'closed' && session && screen !== 'home') banner('Disconnected');
    else banner('');
  },
};

/* ---------------- lobby ---------------- */

let qrCache = { url: null, svg: '' };
function qrMarkup(url) {
  if (!qr || !qr.qrSVG || !url) return '';
  if (qrCache.url !== url) {
    try { qrCache = { url, svg: qr.qrSVG(url, { dark: '#3a3150', light: '#fdf6ee', border: 1 }) }; } catch (e) { console.warn(e); qrCache = { url, svg: '' }; }
  }
  return qrCache.svg;
}

let stopArmed = false;
function showLobby(l) {
  if (screen !== 'lobby') { setScreen('lobby'); stopArmed = false; }
  const url = l.joinUrl || '';
  const seats = [0, 1, 2, 3].map((i) => {
    const m = l.members[i];
    if (!m) return '<li class="cpu"><span class="av">?</span><span class="nm">Computer<small>open seat</small></span></li>';
    const tags = [m.host && 'host', m.you && 'you', !m.connected && 'offline'].filter(Boolean).join(' · ');
    return `<li class="${m.connected ? '' : 'off'}"><span class="av">${esc((m.name || '?').slice(0, 1).toUpperCase())}</span><span class="nm">${esc(m.name)}${tags ? `<small>${tags}</small>` : ''}</span></li>`;
  }).join('');
  const others = l.mode === 'lan' ? (l.lanUrls || []).filter((u) => u !== url) : [];
  const n = l.members.length;
  // a localhost link is useless to friends: say so instead of showing a QR for it
  const noLan = l.mode === 'lan' && /^https?:\/\/(localhost|127\.|\[::1\])/i.test(url) && !(l.lanUrls || []).length;
  const svg = noLan ? '' : qrMarkup(url);
  const len = (l.settings && l.settings.length) || 1;
  app.innerHTML = `<div class="card lobby"><div class="c1">
    ${logo()}
    ${l.mode === 'online' && l.code ? `<div class="muted small" style="text-align:center">Room code</div><div class="code">${esc(l.code)}</div>`
      : noLan ? `<p class="muted">No Wi-Fi network found, so friends can't join yet. Connect this device to Wi-Fi (or turn on its hotspot) and reopen this page — or just play against the computer.</p>`
      : `<p class="muted">Scan to join from a phone or tablet on the same Wi-Fi.</p>`}
    ${svg ? `<div class="qr">${svg}</div>` : ''}
    ${l.mode === 'lan' && !noLan && codeForUrl(url) ? `<div class="tablecode"><span class="muted small">Table code</span> <b>${esc(codeForUrl(url))}</b></div>` : ''}
    ${url && !noLan ? `<div class="joinrow"><input readonly value="${esc(url)}" id="link" aria-label="Invite link"><button class="act" id="copy">Copy</button></div>` : ''}
    ${others.length ? `<p class="urls">Also: ${others.map(esc).join(' · ')}</p>` : ''}</div>
    <div class="c2"><ul class="seats">${seats}</ul>
    ${l.isHost ? `
      <div class="lenrow"><label>Length</label>
      <div class="seg" id="len">
        <button class="chip${len === 1 ? ' on' : ''}" data-len="1">East round</button>
        <button class="chip${len === 2 ? ' on' : ''}" data-len="2">Half game</button>
      </div></div>
      <button class="act hot wide" id="start">Start${n < 4 ? ` · ${4 - n} computer${n === 3 ? '' : 's'}` : ''}</button>`
    : `<p class="muted" style="text-align:center">${len === 2 ? 'Half game' : 'East round'} · waiting for the host to start…</p>`}
    <div class="btnrow"><button class="act ghost wide" id="leave">Leave</button>
    ${l.isHost && l.mode === 'lan' && info ? `<button class="act danger wide${stopArmed ? ' armed' : ''}" id="stop">${stopArmed ? 'Tap again to stop' : 'Stop server'}</button>` : ''}</div></div>
  </div>`;
  if (url && !noLan) {
    const linkEl = $('link');
    linkEl.onfocus = () => linkEl.select();
    $('copy').onclick = () => copyText(url, linkEl);
  }
  $('leave').onclick = leave;
  if (l.isHost) {
    $('len').onclick = (e) => { const b = e.target.closest('[data-len]'); if (b) session.setSettings({ length: +b.dataset.len }); };
    $('start').onclick = (e) => { e.target.disabled = true; session.start(); };
  }
  const stop = $('stop');
  if (stop) stop.onclick = () => {
    if (!stopArmed) { stopArmed = true; stop.classList.add('armed'); stop.textContent = 'Tap again to stop'; return; }
    stop.disabled = true;
    fetch('/api/quit', { method: 'POST' }).catch(() => {}).finally(showStopped);
  };
}

async function copyText(text, input) {
  try {
    if (!navigator.clipboard || !window.isSecureContext) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    toast('Link copied');
  } catch {
    input.focus();
    input.select();
    input.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    toast(ok ? 'Link copied' : 'Link selected — copy it from the box');
  }
}

/* ---------------- game ---------------- */

function act(a) {
  ui.riichiMode = false;
  ui.selected = null;
  if (session) session.act(a);
}

function onGameClick(e) {
  const btn = e.target.closest('[data-act]');
  if (btn) {
    const a = JSON.parse(btn.dataset.act);
    if (a.type === 'ui-riichi') { ui.riichiMode = !ui.riichiMode; ui.selected = null; table.update(view, ui); return; }
    if (a.type === 'ui-lobby') { session.backToLobby(); return; }
    if (a.type === 'ui-leave') { leave(); return; }
    act(a);
    return;
  }
  const t = e.target.closest('#hand .tile[data-id]');
  if (!t || !view || !view.options) {
    if (ui.selected != null && e.target.closest('#hand, #table')) setSelected(null);
    return;
  }
  const id = +t.dataset.id;
  const list = ui.riichiMode ? view.options.riichi : view.options.discard;
  if (!list.includes(id)) return;
  if (pointerType !== 'mouse' && ui.selected !== id) { setSelected(id); return; }
  act({ type: 'discard', tile: id, riichi: ui.riichiMode });
}

function setSelected(id) {
  // lift without a re-render
  for (const el of app.querySelectorAll('#hand .tile.sel')) el.classList.remove('sel');
  ui.selected = id;
  if (id != null) { const el = app.querySelector(`#hand .tile[data-id="${id}"]`); if (el) el.classList.add('sel'); }
}

function renderGame(v) {
  if (screen !== 'game') {
    setScreen('game', 'game');
    table = new Table(app);
    app.onclick = onGameClick;
  }
  view = v;
  if (!v.options) { ui.riichiMode = false; ui.selected = null; }
  else if (ui.selected != null && ![v.drawn, ...v.hand].includes(ui.selected)) ui.selected = null;
  document.title = v.phase === 'over' ? 'minimaj · game over' : `minimaj · ${roundName(v)}`;
  const { event } = table.update(v, ui);
  feedback(v, prev, event);
  prev = v;

  // riichi: the drawn tile is discarded for you
  if (v.options && v.riichiLocked && !v.options.tsumo && !v.options.ankan.length) {
    const key = `${v.round}:${v.kyoku}:${v.wall}:${v.options.discard[0]}`;
    if (ui.autoKey !== key) {
      ui.autoKey = key;
      setTimeout(() => { if (view === v) act({ type: 'discard', tile: v.options.discard[0] }); }, 650);
    }
  }
}

function feedback(v, p, event) {
  if (!p) return;
  const count = (x) => x.players.reduce((n, q) => n + q.discards.length, 0);
  if (event) {
    const t = event.text;
    if (t === 'Ron' || t === 'Tsumo') sfx.win();
    else if (t === 'Riichi') sfx.riichi();
    else if (t === 'Ryuukyoku') sfx.draw();
    else sfx.call();
  }
  if (!event && count(v) > count(p)) sfx.discard();
}

/* ---------------- global input ---------------- */

window.addEventListener('pointerdown', (e) => { pointerType = e.pointerType || 'mouse'; }, { capture: true, passive: true });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('menu').hidden) { $('menu').hidden = true; return; }
    if (view && ui.riichiMode) { ui.riichiMode = false; table.update(view, ui); }
  }
});
window.addEventListener('beforeunload', (e) => {
  if (session && session.mode === 'online' && session.isHost && screen === 'game' && view && view.phase !== 'over') {
    e.preventDefault(); e.returnValue = '';
  }
});
window.addEventListener('hashchange', () => { if (screen === 'home' && !info) showHome(); });

/* ---------------- boot ---------------- */

async function boot() {
  setupMenu();
  let loadErr = null;
  try {
    net = await import(FAKE ? './dev-fake.js' : './net.js');
  } catch (e) {
    console.error(e);
    loadErr = 'Could not load the game code. Please reload.';
  }
  if (net && !net.createSession) loadErr = 'This page is out of date. Please reload.';
  try { qr = await import('./qr.js'); } catch { qr = null; }
  try { info = net && net.detectServer ? await net.detectServer() : null; } catch { info = null; }
  // arriving from another table's "join a friend" (…/?n=Name&go=1): join straight away
  if (!loadErr && info && params.has('go')) {
    const n = (params.get('n') || '').trim().slice(0, 16);
    if (n) store.set('minimaj-name', n);
    history.replaceState(null, '', location.pathname);
    showHome();
    connect({ mode: 'lan', name: n || store.get('minimaj-name', '') || 'Player', info });
    return;
  }
  showHome(loadErr);
  const prev = !loadErr && !FAKE ? auto.load() : null;
  if (prev && prev.name && (prev.mode === 'lan' ? !!info : !info)) connect(prev.mode === 'lan' ? { ...prev, info } : prev);
  if (FAKE && params.has('auto')) $(info ? 'join' : 'create').click();
}
boot();
