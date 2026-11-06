import { Table, tileHTML, roundName, playEmoteOn, emoteGestures, awayFX } from './ui.js';
import { codeForUrl, parseTableInput, scanTables } from './lan.js';
import { animalSVG, ANIMAL_NAMES } from './animals.js';

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
  // locked: your hand is kept sorted; unlocked: drag tiles into your own order
  locktiles: store.get('minimaj-locktiles', '1') === '1',
};
const applyManNumerals = () => document.documentElement.classList.toggle('man-arabic', !prefs.mankanji);
applyManNumerals();

// Color themes (style.css, [data-theme] blocks). index.html sets the saved one before
// the first paint; this keeps it valid and the browser chrome color in step.
const THEMES = [
  ['plum', 'Plum', 'Plum night'], ['matcha', 'Matcha', 'Matcha'], ['sakura', 'Sakura', 'Sakura'],
  ['ocean', 'Ocean', 'Ocean'], ['felt', 'Felt', 'Classic felt'], ['wood', 'Wood', 'Walnut wood'],
  ['midnight', 'Midnight', 'Midnight'], ['washi', 'Washi', 'Washi paper (light)'], ['peach', 'Sunset', 'Peach sunset'],
];
let theme = store.get('minimaj-theme', 'plum');
function applyTheme() {
  if (!THEMES.some(([id]) => id === theme)) theme = 'plum';
  const root = document.documentElement;
  root.dataset.theme = theme;
  const cs = getComputedStyle(root);
  const meta = (n) => document.querySelector(`meta[name="${n}"]`);
  if (meta('theme-color')) meta('theme-color').content = cs.getPropertyValue('--bg-0').trim();
  if (meta('color-scheme')) meta('color-scheme').content = cs.colorScheme || 'dark';
}
applyTheme();

let net = null;       // session module (js/net.js or js/dev-fake.js)
let info = null;      // /info.json when served by the minimaj app, else null
let qr = null;        // js/qr.js module, if available
let session = null;
let sessionToken = null; // identifies the live session's callbacks (see connect)
let screen = 'home';
let table = null;
let view = null;
let prev = null;      // previous view (for sounds)
const ui = { riichiMode: false, selected: null, autoKey: null, free: !prefs.locktiles };
let sent = null;      // { view, t }: the action already sent for this view (no double submits)
let startPending = false; // lobby Start pressed, game not shown yet
let pointerType = 'mouse';

/* ---------------- toast / banner ---------------- */

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
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

// Full-screen toggle next to the menu button. Only where the browser supports
// it for pages (not iPhone Safari) and not inside the Android app's WebView,
// which already fills the screen.
const FS_ENTER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const FS_EXIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';
function setupFullscreen() {
  const btn = $('fsbtn');
  const d = document, el = d.documentElement;
  const supported = (d.fullscreenEnabled || d.webkitFullscreenEnabled) && (el.requestFullscreen || el.webkitRequestFullscreen);
  const inAndroidApp = /; wv\)/.test(navigator.userAgent);
  // launched from the Home Screen (installed web app): already full screen
  const installed = navigator.standalone === true
    || (window.matchMedia && matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches);
  if (!btn || inAndroidApp || installed) return;
  if (!supported) {
    // iPhone Safari has no page full screen: the button explains how to get it
    // (Share → Add to Home Screen opens minimaj full screen, like an app).
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!ios) return;
    btn.innerHTML = FS_ENTER;
    btn.setAttribute('aria-label', 'How to play full screen');
    btn.title = 'Full screen';
    btn.onclick = (e) => {
      e.stopPropagation();
      toast('For full screen: tap Share (□↑) → "Add to Home Screen", then open minimaj from its icon', 6000);
    };
    btn.hidden = false;
    return;
  }
  const isFs = () => !!(d.fullscreenElement || d.webkitFullscreenElement);
  const sync = () => {
    const on = isFs();
    btn.innerHTML = on ? FS_EXIT : FS_ENTER;
    btn.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    btn.title = on ? 'Exit full screen' : 'Full screen';
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    try {
      if (isFs()) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      else {
        const p = (el.requestFullscreen || el.webkitRequestFullscreen).call(el, { navigationUI: 'hide' });
        if (p && p.catch) p.catch(() => toast('Full screen is not available here'));
      }
    } catch { toast('Full screen is not available here'); }
  };
  d.addEventListener('fullscreenchange', sync);
  d.addEventListener('webkitfullscreenchange', sync);
  sync();
  btn.hidden = false;
  d.documentElement.classList.add('has-fs');
}

function setupMenu() {
  setupFullscreen();
  const btn = $('menubtn');
  btn.innerHTML = ICON;
  btn.hidden = false; // on every screen, so the theme can be changed anytime
  btn.onclick = (e) => { e.stopPropagation(); toggleMenu(); };
  document.addEventListener('click', (e) => { if (!$('menu').hidden && !e.target.closest('#menu')) closeMenu(); });
}

function closeMenu() {
  $('menu').hidden = true;
  $('menubtn').setAttribute('aria-expanded', 'false');
}

function toggleMenu(force) {
  const m = $('menu');
  const show = force ?? m.hidden;
  if (!show) { closeMenu(); return; }
  $('menubtn').setAttribute('aria-expanded', 'true');
  const sw = (k, label) => `<button data-pref="${k}" class="${prefs[k] ? 'on' : ''}" aria-pressed="${prefs[k]}">${label}<span class="sw"></span></button>`;
  const swatch = ([id, short, full]) => `<button class="thm${id === theme ? ' on' : ''}" data-theme="${id}" role="radio" aria-checked="${id === theme}" aria-label="${full}" title="${full}">`
    + `<span class="sf"><i class="b"></i><i class="f"></i><i class="a"></i></span><span class="nm">${short}</span></button>`;
  m.innerHTML = '<div class="mopts">' + sw('sound', 'Sound') + sw('locktiles', 'Lock tile order')
    + `<button data-menu="mannum">Man numbers<span class="val">${prefs.mankanji ? '一二三' : '1 2 3'}</span></button>`
    + (session ? `<hr><button class="leave" data-menu="leave">Leave table</button>` : '')
    // only on the device running the minimaj app's table
    + (info && info.hostOk ? `${session ? '' : '<hr>'}<button class="leave" data-menu="stop">Stop server</button>` : '')
    + `</div><div class="mtheme"><div class="mlabel" id="thlabel">Theme</div><div class="thgrid" role="radiogroup" aria-labelledby="thlabel">${THEMES.map(swatch).join('')}</div></div>`;
  m.hidden = false;
  let stopArmedMenu = false;
  m.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.theme) {
      theme = b.dataset.theme;
      store.set('minimaj-theme', theme);
      applyTheme();
      for (const t of m.querySelectorAll('.thm')) { t.classList.toggle('on', t === b); t.setAttribute('aria-checked', t === b); }
    } else if (b.dataset.pref) {
      const k = b.dataset.pref;
      prefs[k] = !prefs[k];
      store.set(`minimaj-${k}`, prefs[k] ? '1' : '0');
      b.classList.toggle('on', prefs[k]);
      b.setAttribute('aria-pressed', prefs[k]);
      if (k === 'sound' && prefs.sound) sfx.tick();
      if (k === 'locktiles') { ui.free = !prefs.locktiles; if (table && view) table.update(view, ui); }
    } else if (b.dataset.menu === 'mannum') {
      prefs.mankanji = !prefs.mankanji;
      store.set('minimaj-mankanji', prefs.mankanji ? '1' : '0');
      b.querySelector('.val').textContent = prefs.mankanji ? '一二三' : '1 2 3';
      applyManNumerals();
    } else if (b.dataset.menu === 'leave') { closeMenu(); leave(); }
    else if (b.dataset.menu === 'stop') {
      // two taps, like the lobby button: everyone at this table is disconnected
      if (!stopArmedMenu) { stopArmedMenu = true; b.textContent = 'Tap again to stop the server'; return; }
      closeMenu();
      stopServer();
    }
  };
}

// Shut the app's table down (only offered on the device running it). On Android
// the app then starts a fresh table and reloads this page at the main menu.
function stopServer() {
  auto.clear(); // the reloaded page must not rejoin the old table
  fetch('/api/quit', { method: 'POST' }).catch(() => {}).finally(showStopped);
}

/* ---------------- screens ---------------- */

function setScreen(name, cls = 'home') {
  screen = name;
  if (table) { table.destroy(); table = null; }
  view = null;
  prev = null;
  ui.riichiMode = false;
  ui.selected = null;
  startPending = false;
  app.className = cls;
  app.onclick = null;
  closeMenu();
  document.title = 'minimaj';
  updateWakeLock();
}

// Keep the screen on while at a table (lobby or game). Phones freeze a page
// when the screen locks; for the host of an online room that stalls the whole
// table ("No answer from the host"). Uses the Screen Wake Lock API where
// available (Chrome/Android, Safari 16.4+); it is released when hidden, so
// it is re-requested when the page becomes visible again.
let wakeLock = null;
const wantWake = () => screen === 'lobby' || screen === 'game' || screen === 'connecting';
async function updateWakeLock() {
  try {
    if (!('wakeLock' in navigator)) return;
    if (wantWake() && document.visibilityState === 'visible') {
      if (!wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } else if (wakeLock) {
      const w = wakeLock; wakeLock = null; await w.release();
    }
  } catch { wakeLock = null; /* not allowed here (e.g. low battery): ignore */ }
}
document.addEventListener('visibilitychange', updateWakeLock);

// three random tiles for the logo, picked once per page load
const LOGO_TILES = (() => { const ids = new Set(); while (ids.size < 3) ids.add(Math.floor(Math.random() * 136)); return [...ids]; })();
const logo = () => `<h1 class="logo"><span class="tiles">${LOGO_TILES.map((t) => tileHTML(t)).join('')}</span>minimaj</h1>`;

function endSession() {
  const s = session;
  session = null;
  sessionToken = null; // first: its last callbacks (onConn 'closed') are then ignored
  if (s) { try { s.close(); } catch { /* ignore */ } }
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

const nameFieldHTML = () => `<label>Your name<input id="name" maxlength="16" autocomplete="nickname" value="${esc(store.get('minimaj-name', ''))}" placeholder="Name" enterkeyhint="go"></label>`;
const errorHTML = (err) => (err ? `<p class="err" role="alert">${esc(err)}</p>` : '');
// Focus a field on the home screens only with a mouse/trackpad: on a phone it
// would pop the keyboard up over the menu every time you come back to it.
const autoFocus = (el) => { if (!FAKE && el && matchMedia('(pointer: fine)').matches) el.focus(); };

function showHome(err) {
  endSession();
  setScreen('home');
  const nameField = nameFieldHTML();
  const errHTML = errorHTML(err);
  if (info) {
    // On your own device you can host your table or join a friend's table.
    const own = !!info.hostOk;
    app.innerHTML = `<div class="card split${own ? ' friend' : ''}"><div class="c1">${logo()}
      <p class="muted">Riichi mahjong${own ? '' : ' at this table'}. Up to four players — empty seats are played by the computer.</p>
      ${own ? '' : '<span class="pill-note">Joining a friend\'s table</span>'}</div>
      <div class="c2">${nameField}
      <button id="join" class="act hot wide">${own ? 'Host a table' : 'Join table'}</button>
      ${own ? `<label class="tick"><input type="checkbox" id="local"><span>Local — same Wi-Fi only</span></label>` : ''}
      ${errHTML}</div>
      ${own ? `<div class="c3"><div class="or">or join a friend</div>
      <ul class="nearby" id="nearby"><li class="muted small" id="scanmsg">Looking for tables nearby…</li></ul>
      <div class="joinrow">
        <input id="tcode" placeholder="Room or table code" autocapitalize="characters" autocomplete="off" spellcheck="false" enterkeyhint="go" aria-label="Online room code, or a local table code or address">
        <button id="joint" class="act">Join</button>
      </div></div>` : ''}
      ${howTo()}
    </div>`;
    const nameEl = $('name');
    // Host: an online room by default (friends anywhere); ticked "Local" = this
    // device's Wi-Fi table (the app's server).
    const go = () => (own && !$('local').checked
      ? connect({ mode: 'online', name: getName(nameEl), create: true, publicUrl: PUBLIC_URL })
      : connect({ mode: 'lan', name: getName(nameEl), info }));
    $('join').onclick = go;
    nameEl.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    if (own) setupJoinFriend(nameEl);
    autoFocus(nameEl);
    return;
  }
  showOnline(err);
}

// Public web version, used for online-room invite links from inside the app
// (the app's own pages live on 127.0.0.1, which friends can't open).
const PUBLIC_URL = 'https://veryniceparts.github.io/minimaj/';

// Online room (internet play via WebRTC). The web version's home screen; in
// the app it's a separate screen reached from "Online room" with a Back button.
function showOnline(err) {
  endSession();
  setScreen('home');
  const inApp = !!info;
  const nameField = nameFieldHTML();
  const errHTML = errorHTML(err);
  const code = !inApp && net && net.normCode ? net.normCode(location.hash.slice(1)) : '';
  app.innerHTML = `<div class="card split"><div class="c1">${logo()}
    <p class="muted">${inApp
      ? 'Online room: play with friends anywhere over the internet. Share the room code; they join from the minimaj app or the web version. Keep this app open while you host.'
      : 'Riichi mahjong with friends, peer-to-peer. Empty seats are played by the computer.'}</p></div>
    <div class="c2">${nameField}
    <button id="create" class="act hot wide">Create room</button>
    <div class="or">or join a friend</div>
    <div class="joinrow">
      <input id="code" maxlength="${inApp ? 5 : 21}" placeholder="CODE" value="${esc(code)}" autocapitalize="characters" autocomplete="off" spellcheck="false" enterkeyhint="go" aria-label="${inApp ? 'Room code' : 'Room code, or a minimaj app\'s table code or address'}">
      <button id="joinc" class="act">Join</button>
    </div>
    ${inApp ? '<button id="back" class="act ghost wide">Back</button>' : ''}
    ${errHTML}</div>
    ${inApp ? '' : howTo()}
  </div>`;
  const nameEl = $('name');
  const codeEl = $('code');
  const extra = inApp ? { publicUrl: PUBLIC_URL } : {};
  $('create').onclick = () => connect({ mode: 'online', name: getName(nameEl), create: true, ...extra });
  const join = () => {
    const raw = codeEl.value.trim();
    // web version: a minimaj app's table code (4 or 6 characters) or address
    // goes to that table's own page; 5 characters are an online room
    if (!inApp && (/[.:]/.test(raw) || /^[a-z0-9]{4}$|^[a-z0-9]{6}$/i.test(raw.replace(/[\s-]/g, '')))) {
      const url = parseTableInput(raw);
      if (url) { goToTable(url, nameEl); return; }
    }
    const c = net.normCode(raw);
    const problem = net.codeProblem ? net.codeProblem(c) : c.length !== 5 ? 'Enter the 5-character room code.' : null;
    if (problem) { codeEl.focus(); toast(problem); return; }
    connect({ mode: 'online', name: getName(nameEl), code: c, ...extra });
  };
  if (inApp) $('back').onclick = () => showHome();
  $('joinc').onclick = join;
  codeEl.onkeydown = (e) => { if (e.key === 'Enter') join(); };
  codeEl.oninput = () => {
    const v = codeEl.value;
    // an address (web version only) is left as typed; codes are cleaned up
    if (inApp) codeEl.value = net.normCode(v);
    else if (!/[.:/]/.test(v)) codeEl.value = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    highlightJoin(codeEl, $('joinc'), $('create'));
  };
  highlightJoin(codeEl, $('joinc'), $('create')); // e.g. a code from an invite link
  autoFocus(code && !nameEl.value ? nameEl : code ? $('joinc') : nameEl);
}

// Joining another minimaj app on the same Wi-Fi: go to that table's page and
// carry the name along (each table is a different origin, so localStorage isn't shared).
function goToTable(url, nameEl) {
  const name = getName(nameEl);
  location.href = `${url}/?n=${encodeURIComponent(name)}&go=1`;
}

// Tables nearby: one scan at a time, results kept for when the home screen is
// shown again (Online room -> Back, Leave), so it does not probe the /24 again.
const scan = { busy: false, at: 0, found: [] };
const RESCAN_MS = 20000;

// With a code typed in (or prefilled from an invite link), Join becomes the
// highlighted button and the host/create button turns plain.
function highlightJoin(codeEl, joinBtn, hostBtn) {
  const on = codeEl.value.trim() !== '';
  joinBtn.classList.toggle('hot', on);
  hostBtn.classList.toggle('hot', !on);
  hostBtn.classList.toggle('ghost', on);
}

function setupJoinFriend(nameEl) {
  const codeEl = $('tcode');
  const join = () => {
    const raw = codeEl.value.trim();
    const compact = raw.replace(/[\s-]/g, '');
    // 5 characters = an online room code; 4/6 characters or an address = a local table
    if (/^[a-z0-9]{5}$/i.test(compact)) {
      const c = net.normCode(compact);
      const problem = net.codeProblem ? net.codeProblem(c) : null;
      if (problem) { codeEl.focus(); toast(problem); return; }
      connect({ mode: 'online', name: getName(nameEl), code: c, publicUrl: PUBLIC_URL });
      return;
    }
    const url = parseTableInput(raw);
    if (!url) { codeEl.focus(); toast('Enter the room code (5 letters) or the table code shown in your friend\'s lobby'); return; }
    goToTable(url, nameEl);
  };
  $('joint').onclick = join;
  codeEl.onkeydown = (e) => { if (e.key === 'Enter') join(); };
  codeEl.oninput = () => highlightJoin(codeEl, $('joint'), $('join'));
  highlightJoin(codeEl, $('joint'), $('join'));
  const fresh = scan.busy || Date.now() - scan.at < RESCAN_MS;
  if (!fresh) scan.busy = true;
  renderNearby();
  if (fresh) return;
  const next = [];
  scanTables(info.lanUrls || [], (hit) => {
    if (next.some((h) => h.url === hit.url)) return;
    next.push(hit);
    if (!scan.found.some((h) => h.url === hit.url)) { scan.found.push(hit); renderNearby(); }
  }).catch(() => {}).finally(() => {
    scan.busy = false;
    scan.at = Date.now();
    scan.found = next; // tables that went away drop out
    renderNearby();
  });
}

// The found tables (at most 3) into the home screen's list, if it is showing.
// Everything in /info.json comes from another device: escape and coerce it all.
function renderNearby() {
  const list = $('nearby');
  if (!list) return;
  if (!scan.found.length) {
    const msg = scan.busy ? 'Looking for tables nearby…'
      : (info.lanUrls || []).length ? 'No tables found nearby — ask for the table code.' : 'Not on Wi-Fi — connect to join friends.';
    list.innerHTML = `<li class="muted small" id="scanmsg">${msg}</li>`;
    return;
  }
  list.replaceChildren(...scan.found.slice(0, 3).map(({ url, code, info: ti }) => {
    const t = (ti && ti.table) || {};
    const host = t.host ? String(t.host).slice(0, 16) : '';
    const n = Math.max(0, Math.floor(+t.players) || 0);
    const detail = [n ? `${n} player${n === 1 ? '' : 's'}` : 'empty', t.playing ? 'playing' : 'in lobby'].join(' · ');
    const li = document.createElement('li');
    li.innerHTML = `<button class="act"><span class="nm">${host ? `${esc(host)}'s table` : 'Table'}<small>${detail}${code ? ` · ${esc(code)}` : ''}</small></span><span class="go">Join</span></button>`;
    li.querySelector('button').onclick = () => goToTable(url, $('name'));
    return li;
  }));
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
  auto.clear();
  endSession();
  setScreen('stopped');
  app.innerHTML = `<div class="card">${logo()}<h2>Server stopped</h2>
    <p class="muted">The minimaj table has been shut down. You can close this window.</p></div>`;
}

// Each session gets its own handlers, bound to a token: callbacks from a session
// that was already left or replaced (late timers, a reconnect racing a Leave)
// are dropped instead of drawing over the current screen.
function connect(opts) {
  if (!net || !net.createSession) { showHome('The networking module did not load. Please reload the page.'); return; }
  endSession();
  showConnecting(opts.mode === 'lan' ? 'Joining the table…' : opts.create ? 'Opening a room…' : `Connecting to room ${opts.code}…`);
  const token = {};
  sessionToken = token;
  try {
    const s = net.createSession(opts, sessionHandlers(token, opts));
    if (sessionToken !== token) { try { s.close(); } catch { /* ignore */ } return; } // failed while starting
    session = s;
    auto.save(opts);
  } catch (e) {
    console.error(e);
    sessionToken = null;
    showHome(e.message || 'Could not connect');
  }
}

function sessionHandlers(token, opts) {
  const live = () => sessionToken === token;
  return {
    onLobby: (l) => { if (live()) showLobby(l); },
    onView: (v) => { if (live()) renderGame(v); },
    onError: (msg, fatal) => {
      if (!live()) return;
      if (!fatal) { toast(msg); return; }
      sessionToken = null;
      auto.clear();
      showHome(msg); // the app's home hosts/joins online rooms too
    },
    onStatus: (text) => { if (live() && text) toast(text); },
    onEmote: (ev) => { if (live()) showEmote(ev); },
    onConn: (state) => {
      if (!live()) return;
      if (state === 'reconnecting') banner('Reconnecting…');
      else if (state === 'connecting' && (screen === 'lobby' || screen === 'game')) banner('Connecting…');
      else if (state === 'closed' && screen !== 'home') banner('Disconnected');
      else banner('');
    },
  };
}

/* ---------------- mascot emotes ---------------- */

// A tap or swipe on your own mascot. It plays here at once; the room's echo of it
// is then skipped (Table.emote / lobbyMine). When the session can't send it (offline,
// too soon after the last one) it still plays here, unless one is showing already.
function myEmote(kind) {
  // a long press puts your mascot to sleep (or wakes it); any gesture while asleep wakes it
  const asleep = amAsleep();
  if (kind === 'afk' || asleep) { setAfk(!asleep); return; }
  const sentOk = !!(session && session.emote && session.emote(kind));
  if (screen === 'game' && table && view) {
    if (sentOk) table.emote(view.seat, kind, true);
    else if (!table.emoting) table.playEmote(0, kind);
  } else if (screen === 'lobby') {
    const el = lobbyMav(lobbyYou);
    if (sentOk) { lobbyMine.push({ kind, at: Date.now() }); playEmoteOn(el, kind); }
    else if (el && !el._emo) playEmoteOn(el, kind);
  }
}

// asleep (afk): the computer plays your seat until you wake up
function amAsleep() {
  if (screen === 'game' && view && view.players && view.players[view.seat]) return view.players[view.seat].away === 'afk';
  return screen === 'lobby' && lobbyAfk;
}
function setAfk(on) {
  if (!session || !session.afk || !session.afk(on)) { toast('Not connected right now'); return; }
  if (on) toast(screen === 'game' ? 'Zzz… the computer plays for you. Tap your mascot to wake up.' : 'Zzz… tap your mascot to wake up.', 3600);
  else toast('Welcome back!', 1600);
}

let lobbyAfk = false; // you are asleep in the lobby
let lobbyMine = []; // your lobby emotes already shown: [{ kind, at }]
let lobbyYou = -1; // your index in lobby.members
const lobbyMav = (i) => { const li = i >= 0 ? app.querySelectorAll('.seats li')[i] : null; return li ? li.querySelector('.mav') : null; };

// { seat, e } in a game; { seat: -1, member, e } in the lobby
function showEmote(ev) {
  if (screen === 'game' && table && ev.seat >= 0) { table.emote(ev.seat, ev.e); return; }
  if (screen !== 'lobby' || !(ev.member >= 0)) return;
  if (ev.member === lobbyYou) {
    const now = Date.now();
    lobbyMine = lobbyMine.filter((m) => now - m.at < 4000);
    const i = lobbyMine.findIndex((m) => m.kind === ev.e);
    if (i >= 0) { lobbyMine.splice(i, 1); return; }
  }
  playEmoteOn(lobbyMav(ev.member), ev.e);
}

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
let lobbyAnimals = []; // mascots last shown per seat (a change pops)
const isAnimal = (a) => Number.isInteger(a) && a >= 0;
function showLobby(l) {
  if (screen !== 'lobby') { setScreen('lobby'); stopArmed = false; lobbyAnimals = []; }
  const url = l.joinUrl || '';
  const left = Math.max(0, l.rerollsLeft | 0);
  const seats = [0, 1, 2, 3].map((i) => {
    const m = l.members[i];
    if (!m) return '<li class="cpu"><span class="av">?</span><span class="nm">Computer<small>open seat</small></span></li>';
    const tags = [m.host && 'host', m.you && 'you', !m.connected && 'offline', m.afk && 'asleep'].filter(Boolean).join(' · ');
    const initial = [...String(m.name || '?')][0].toUpperCase(); // whole code point (emoji names)
    const has = isAnimal(m.animal);
    const pop = has && isAnimal(lobbyAnimals[i]) && lobbyAnimals[i] !== m.animal ? ' pop' : '';
    const av = has ? `<span class="av mav${pop}${m.afk ? ' afk' : ''}" title="${esc(ANIMAL_NAMES[m.animal] || '')}">${animalSVG(m.animal)}${m.afk ? awayFX('afk') : ''}</span>` : `<span class="av">${esc(initial)}</span>`;
    if (m.you && has && l.rerollsLeft != null) {
      // your seat: a bigger mascot; tap it for another one (a few times per lobby),
      // hold it to fall asleep. Not [disabled] when out of rerolls: it still takes gestures.
      const note = m.afk ? 'asleep · tap to wake' : left ? `🎲 Reroll (${left}<span class="lw"> left</span>)` : 'no rerolls left';
      return `<li class="me${m.connected ? '' : ' off'}"><button class="reroll${left || m.afk ? '' : ' spent'}" id="reroll"
        aria-label="Your mascot: ${esc(ANIMAL_NAMES[m.animal] || '')}. ${m.afk ? 'Asleep, tap to wake up' : left ? `Reroll, ${left} left` : 'No rerolls left'}">${av}<span class="nm">${esc(m.name)}<small>${note}</small></span></button></li>`;
    }
    return `<li class="${m.connected ? '' : 'off'}">${av}<span class="nm">${esc(m.name)}${tags ? `<small>${tags}</small>` : ''}</span></li>`;
  }).join('');
  lobbyAnimals = [0, 1, 2, 3].map((i) => (l.members[i] ? l.members[i].animal : null));
  lobbyYou = l.members.findIndex((m) => m.you);
  lobbyAfk = !!(l.members[lobbyYou] && l.members[lobbyYou].afk);
  const others = l.mode === 'lan' ? (l.lanUrls || []).filter((u) => u !== url) : [];
  const n = l.members.length;
  // a localhost link is useless to friends: say so instead of showing a QR for it
  const noLan = l.mode === 'lan' && /^https?:\/\/(localhost|127\.|\[::1\])/i.test(url) && !(l.lanUrls || []).length;
  const svg = noLan ? '' : qrMarkup(url);
  const len = (l.settings && l.settings.length) || 1;
  app.innerHTML = `<div class="card lobby"><div class="c1">
    ${logo()}
    ${l.mode === 'online' && l.code ? `<div class="muted small" style="text-align:center">Room code · tap to copy</div><button class="code tapcopy" id="copycode" aria-label="Room code ${esc(l.code)}, tap to copy">${esc(l.code)}</button>`
      : noLan ? `<p class="muted">No Wi-Fi network found, so friends can't join yet. Connect this device to Wi-Fi (or turn on its hotspot) and reopen this page — or just play against the computer.</p>`
      : `<p class="muted">Scan to join from a phone or tablet on the same Wi-Fi.</p>`}
    ${svg ? `<div class="qr">${svg}</div>` : ''}
    ${l.mode === 'lan' && !noLan && codeForUrl(url) ? `<div class="tablecode"><span class="muted small">Table code</span> <b>${esc(codeForUrl(url))}</b></div>` : ''}
    ${url && !noLan ? `<input readonly value="${esc(url)}" id="link" class="tapcopy" title="Tap to copy the invite link" aria-label="Invite link, tap to copy">` : ''}
    ${others.length ? `<p class="urls">Also: ${others.map(esc).join(' · ')}</p>` : ''}</div>
    <div class="c2"><ul class="seats">${seats}</ul>
    ${l.isHost ? `
      <div class="lenrow"><label>Length</label>
      <div class="seg" id="len">
        <button class="chip${len === 1 ? ' on' : ''}" data-len="1" title="East round only (tonpuu)">Short · 東</button>
        <button class="chip${len === 2 ? ' on' : ''}" data-len="2" title="East and South rounds (hanchan)">Long · 東南</button>
      </div></div>
      <button class="act hot wide" id="start"${startPending ? ' disabled' : ''}>Start${n < 4 ? ` · ${4 - n} computer${n === 3 ? '' : 's'}` : ''}</button>`
    : `<p class="muted" style="text-align:center">${len === 2 ? 'Long game (東南)' : 'Short game (東)'} · waiting for the host to start…</p>`}
    <div class="btnrow"><button class="act ghost wide" id="leave">Leave</button>
    ${l.isHost && l.mode === 'lan' && info ? `<button class="act danger wide${stopArmed ? ' armed' : ''}" id="stop">${stopArmed ? 'Tap again to stop' : 'Stop server'}</button>` : ''}</div></div>
  </div>`;
  if (url && !noLan) {
    const linkEl = $('link');
    // tapping the link copies it
    linkEl.onclick = () => copyText(url, linkEl);
  }
  const cc = $('copycode');
  if (cc) cc.onclick = () => copyText(l.code, null, 'Room code'); // tapping the code copies it
  $('leave').onclick = leave;
  const rr = $('reroll');
  // swipe your mascot to emote (a tap still rerolls)
  const myMav = rr && rr.querySelector('.mav');
  if (myMav) {
    emoteGestures(myMav, (kind) => {
      if (kind === 'go' && !lobbyAfk) return;
      rr._swiped = Date.now();
      myEmote(kind);
    });
  }
  if (rr) rr.onclick = () => {
    if (rr._swiped && Date.now() - rr._swiped < 800) { rr._swiped = 0; return; } // that was a swipe
    if (!session || !session.reroll || !left || lobbyAfk || rr.disabled) return;
    rr.disabled = true; // until the new mascot arrives (re-enabled if the host never answers)
    session.reroll();
    setTimeout(() => { if (rr.isConnected && left > 0) rr.disabled = false; }, 2000);
  };
  if (l.isHost) {
    $('len').onclick = (e) => { const b = e.target.closest('[data-len]'); if (b && session) session.setSettings({ length: +b.dataset.len }); };
    $('start').onclick = (e) => {
      if (startPending || !session) return;
      // stays disabled across lobby updates until the game shows (or a few seconds pass)
      startPending = true;
      e.currentTarget.disabled = true;
      session.start();
      const s = session;
      setTimeout(() => { if (session === s && screen === 'lobby' && startPending) { startPending = false; const b = $('start'); if (b) b.disabled = false; } }, 4000);
    };
  }
  const stop = $('stop');
  if (stop) stop.onclick = () => {
    if (!stopArmed) { stopArmed = true; stop.classList.add('armed'); stop.textContent = 'Tap again to stop'; return; }
    stop.disabled = true;
    stopServer();
  };
}

// Copy text; without the async clipboard (plain http) fall back to selecting it
// in `input` (or a temporary off-screen field) and execCommand('copy').
async function copyText(text, input, what = 'Link') {
  try {
    if (!navigator.clipboard || !window.isSecureContext) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    let tmp = null;
    if (!input) {
      tmp = document.createElement('textarea');
      tmp.value = text;
      tmp.setAttribute('readonly', '');
      tmp.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(tmp);
      input = tmp;
    }
    input.focus();
    input.select();
    input.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    if (tmp) tmp.remove();
    toast(ok ? `${what} copied` : tmp ? `${what}: ${text}` : `${what} selected — copy it from the box`);
  }
}

/* ---------------- game ---------------- */

function act(a) {
  ui.riichiMode = false;
  ui.selected = null;
  if (!session) return;
  // one action per state: a double tap (or the riichi auto-discard racing a tap)
  // must not send a second discard before the server's answer arrives
  const now = Date.now();
  if (sent && sent.view === view && now - sent.t < 1500) return;
  sent = { view, t: now };
  session.act(a);
}

function onGameClick(e) {
  const btn = e.target.closest('[data-act]');
  if (btn) {
    const a = JSON.parse(btn.dataset.act);
    if (a.type === 'ui-riichi') { ui.riichiMode = !ui.riichiMode; ui.selected = null; table.update(view, ui); return; }
    if (a.type === 'ui-lobby') { if (session) session.backToLobby(); return; }
    if (a.type === 'ui-again') {
      btn.disabled = true; // one tap: the new game's first view replaces this card
      if (session && session.playAgain) session.playAgain();
      return;
    }
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
    table.onEmote = myEmote;
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
    if (!$('menu').hidden) { closeMenu(); $('menubtn').focus({ preventScroll: true }); return; }
    if (view && table && ui.riichiMode) { ui.riichiMode = false; table.update(view, ui); }
  }
});
window.addEventListener('beforeunload', (e) => {
  if (session && session.mode === 'online' && session.isHost && screen === 'game' && view && view.phase !== 'over') {
    e.preventDefault(); e.returnValue = '';
  }
});
window.addEventListener('hashchange', () => {
  if (screen !== 'home' || info) return;
  const nameEl = $('name');
  if (nameEl && nameEl.value.trim()) getName(nameEl); // keep what was typed
  showHome();
});

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
  // a reload at a table rejoins it. Online rooms work in the browser and inside
  // the app; LAN tables only in the app
  const saved = !loadErr && !FAKE ? auto.load() : null;
  if (saved && saved.name && (saved.mode === 'lan' ? !!info : true)) connect(saved.mode === 'lan' ? { ...saved, info } : saved);
  if (FAKE && params.has('auto')) $(info ? 'join' : 'create').click();
}
// Used by the Android app's back button: which screen is showing, and leave the table.
window.minimajNav = {
  screen: () => screen,
  leave: () => { if (screen !== 'home') leave(); },
};

boot();
