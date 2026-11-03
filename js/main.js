import { HostSession, ClientSession, normCode } from './net.js';
import { boardHTML, handHTML, actionsHTML, resultHTML, roundName } from './ui.js';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const coarse = matchMedia('(pointer: coarse)').matches;

let session = null;
let isHost = false;
let view = null;
const ui = { riichiMode: false, selected: null, lastEvent: 0, lastResultKey: null, gameBuilt: false };

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

/* ---------------- home ---------------- */

function showHome(err) {
  if (session) { session.close(); session = null; }
  ui.gameBuilt = false;
  view = null;
  const code = normCode(location.hash.slice(1));
  app.className = 'home';
  app.innerHTML = `
    <div class="card">
      <h1>minimaj</h1>
      <p class="muted">Riichi mahjong with friends. Peer-to-peer, no accounts.<br>Empty seats are played by the computer.</p>
      <label>Your name<input id="name" maxlength="16" autocomplete="nickname" value="${esc(store.get('minimaj-name', ''))}" placeholder="Name"></label>
      <button id="create" class="act hot wide">Create room</button>
      <div class="or">or join a friend</div>
      <div class="joinrow">
        <input id="code" maxlength="5" placeholder="CODE" value="${esc(code)}" autocapitalize="characters" spellcheck="false">
        <button id="join" class="act">Join</button>
      </div>
      ${err ? `<p class="err">${esc(err)}</p>` : ''}
      <details><summary>How to play</summary>
        <p>Create a room and send the link or 5-letter code to up to three friends. When everyone is in, press Start — remaining seats get computer players.</p>
        <p>Click a tile to discard it (tap twice on touch screens). Call buttons appear when you can Chi, Pon, Kan, Ron, Tsumo or Riichi. The host's tab runs the game, so the host should keep it open.</p>
      </details>
    </div>`;
  const nameEl = document.getElementById('name');
  const codeEl = document.getElementById('code');
  const getName = () => {
    const n = nameEl.value.trim() || 'Player';
    store.set('minimaj-name', n);
    return n;
  };
  document.getElementById('create').onclick = () => startHost(getName());
  const join = () => {
    const c = normCode(codeEl.value);
    if (c.length !== 5) { codeEl.focus(); toast('Enter the 5-character room code'); return; }
    startClient(getName(), c);
  };
  document.getElementById('join').onclick = join;
  codeEl.onkeydown = (e) => { if (e.key === 'Enter') join(); };
  codeEl.oninput = () => { codeEl.value = normCode(codeEl.value); };
  (code ? codeEl : nameEl).focus();
}

function showConnecting(text) {
  app.className = 'home';
  app.innerHTML = `<div class="card"><h1>minimaj</h1><p class="muted">${esc(text)}</p>
    <button class="act ghost" id="cancel">Cancel</button></div>`;
  document.getElementById('cancel').onclick = () => { location.hash = ''; showHome(); };
}

const handlers = {
  onLobby: (l) => showLobby(l),
  onView: (v) => renderGame(v),
  onError: (msg) => showHome(msg),
  onStatus: (msg) => toast(msg),
  onLost: () => showLost(),
};

function startHost(name) {
  isHost = true;
  showConnecting('Opening room…');
  session = new HostSession(name, handlers);
}

function startClient(name, code) {
  isHost = false;
  showConnecting(`Connecting to room ${code}…`);
  session = new ClientSession(name, code, handlers);
}

function showLost() {
  ui.gameBuilt = false;
  app.className = 'home';
  app.innerHTML = `<div class="card"><h1>minimaj</h1><p class="err">Connection to the host was lost.</p>
    <button class="act hot wide" id="re">Reconnect</button><button class="act ghost wide" id="home">Leave</button></div>`;
  document.getElementById('re').onclick = () => { showConnecting('Reconnecting…'); session.reconnect(); };
  document.getElementById('home').onclick = () => { location.hash = ''; showHome(); };
}

/* ---------------- lobby ---------------- */

function showLobby(l) {
  ui.gameBuilt = false;
  view = null;
  const link = `${location.origin}${location.pathname}#${l.code}`;
  if (isHost) history.replaceState(null, '', `#${l.code}`);
  const seats = [0, 1, 2, 3].map((i) => {
    const m = l.members[i];
    return m ? `<li>${esc(m.name)}${m.host ? ' <small>host</small>' : ''}</li>` : '<li class="muted">Computer player</li>';
  }).join('');
  app.className = 'home';
  app.innerHTML = `
    <div class="card">
      <h1>Room</h1>
      <div class="code" title="Room code">${esc(l.code)}</div>
      <div class="joinrow">
        <input readonly value="${esc(link)}" id="link">
        <button class="act" id="copy">Copy link</button>
      </div>
      <ul class="seats">${seats}</ul>
      ${l.host ? `
        <label>Length
          <select id="len">
            <option value="1"${l.settings.length === 1 ? ' selected' : ''}>East round (4+ hands)</option>
            <option value="2"${l.settings.length === 2 ? ' selected' : ''}>Half game — East + South</option>
          </select>
        </label>
        <button class="act hot wide" id="start">Start${l.members.length < 4 ? ` with ${4 - l.members.length} computer${l.members.length === 3 ? '' : 's'}` : ''}</button>`
      : `<p class="muted">${l.settings.length === 2 ? 'Half game' : 'East round'} · waiting for the host to start…</p>`}
      <button class="act ghost wide" id="leave">Leave</button>
    </div>`;
  document.getElementById('copy').onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast('Invite link copied'); } catch {
      document.getElementById('link').select(); toast('Copy the link above');
    }
  };
  document.getElementById('leave').onclick = () => { location.hash = ''; showHome(); };
  if (l.host) {
    document.getElementById('len').onchange = (e) => session.setSettings({ length: +e.target.value });
    document.getElementById('start').onclick = () => session.start();
  }
}

/* ---------------- game ---------------- */

function buildGame() {
  app.className = 'game';
  app.innerHTML = `
    <div id="table"><div id="wrap"><div id="board"></div><div id="announce"></div></div></div>
    <div id="bar">
      <div id="status"><span id="hint"></span><span id="actions"></span></div>
      <div id="hand"></div>
    </div>
    <div id="modal" hidden><div class="card" id="modalcard"></div></div>`;
  ui.gameBuilt = true;
  app.onclick = onGameClick;
}

function send(a) {
  ui.riichiMode = false;
  ui.selected = null;
  session.act(a);
}

function onGameClick(e) {
  const btn = e.target.closest('[data-act]');
  if (btn) {
    const a = JSON.parse(btn.dataset.act);
    if (a.type === 'ui-riichi') { ui.riichiMode = !ui.riichiMode; ui.selected = null; renderGame(view); return; }
    if (a.type === 'ui-lobby') { session.backToLobby(); return; }
    send(a);
    return;
  }
  const t = e.target.closest('#hand .tile[data-id]');
  if (t && view && view.options) {
    const id = +t.dataset.id;
    const list = ui.riichiMode ? view.options.riichi : view.options.discard;
    if (!list.includes(id)) return;
    if (coarse && ui.selected !== id) { ui.selected = id; renderGame(view); return; }
    send({ type: 'discard', tile: id, riichi: ui.riichiMode });
  }
}

function renderGame(v) {
  view = v;
  if (!ui.gameBuilt) buildGame();
  if (!v.options) { ui.riichiMode = false; ui.selected = null; }
  document.title = `minimaj · ${roundName(v)}`;
  document.getElementById('board').innerHTML = boardHTML(v);
  document.getElementById('hand').innerHTML = handHTML(v, ui);
  const a = actionsHTML(v, ui);
  document.getElementById('hint').innerHTML = a.hint;
  document.getElementById('actions').innerHTML = a.html;
  document.getElementById('bar').classList.toggle('myturn', !!(v.options || v.claim));

  if (v.event && v.event.id !== ui.lastEvent) {
    ui.lastEvent = v.event.id;
    const r = (v.event.seat - v.seat + 4) % 4;
    const el = document.getElementById('announce');
    el.innerHTML = `<span class="ev p${r}">${esc(v.event.text)}</span>`;
  }

  const modal = document.getElementById('modal');
  if (v.result || v.final) {
    modal.hidden = false;
    document.getElementById('modalcard').innerHTML = resultHTML(v, { isHost });
  } else modal.hidden = true;

  // auto-pass is never done for you, but riichi auto-discards the drawn tile
  if (v.options && v.riichiLocked && !v.options.tsumo && !v.options.ankan.length) {
    const key = `${v.wall}:${v.options.discard[0]}`;
    if (ui.autoKey !== key) {
      ui.autoKey = key;
      setTimeout(() => { if (view === v) send({ type: 'discard', tile: v.options.discard[0] }); }, 600);
    }
  }
}

window.addEventListener('keydown', (e) => {
  if (!view || e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape' && ui.riichiMode) { ui.riichiMode = false; renderGame(view); }
});

window.addEventListener('beforeunload', (e) => {
  if (isHost && session && session.game && session.game.phase !== 'over') { e.preventDefault(); e.returnValue = ''; }
});

if (typeof Peer === 'undefined') {
  showHome('Could not load the networking library (PeerJS). Check your connection or ad-blocker and reload.');
} else showHome();
