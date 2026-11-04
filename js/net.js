// Session layer: connects the UI to a room (js/room.js).
//   LAN mode:    the room runs in the native server; we talk over a WebSocket.
//   Online mode: the creator's tab runs the room itself (its own UI is the
//                in-page connection 'self'); others connect over WebRTC data
//                channels set up by PeerJS (loaded on demand).
// Both client kinds send a ping every 3 s; 9 s without any message means the
// link is dead, and we reconnect with backoff using the same client id, so the
// room hands our seat back.
import { createRoom, PROTO } from './room.js';

const PREFIX = 'minimaj-v1-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PING_MS = 3000;
const DEAD_MS = 9000;
const TICK_MS = 1000;
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const CONNECT_TIMEOUT_MS = 12000;

export const makeCode = () => Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
export const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

function storageGet(store, k) { try { return window[store].getItem(k); } catch (e) { return null; } }
function storageSet(store, k, v) { try { window[store].setItem(k, v); } catch (e) { /* ignore */ } }

function clientId() {
  let id = storageGet('localStorage', 'minimaj-cid');
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    storageSet('localStorage', 'minimaj-cid', id);
  }
  return id;
}

// Info from the native server, or null when the page is served statically.
export async function detectServer() {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, 1500);
  try {
    const r = await fetch('/info.json', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (!r.ok) return null;
    const info = await r.json();
    return info && info.server === true ? info : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let peerJsPromise = null;
function loadPeerJS() {
  if (typeof window.Peer === 'function') return Promise.resolve(window.Peer);
  if (!peerJsPromise) {
    peerJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('./vendor/peerjs.min.js', import.meta.url).href;
      s.async = true;
      s.onload = () => (typeof window.Peer === 'function' ? resolve(window.Peer) : reject(new Error('PeerJS missing')));
      s.onerror = () => { peerJsPromise = null; reject(new Error('Could not load PeerJS')); };
      document.head.appendChild(s);
    });
  }
  return peerJsPromise;
}

function peerErrorText(err) {
  switch (err && err.type) {
    case 'peer-unavailable': return 'Room not found. Check the code — the host must keep their tab open.';
    case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
      return 'Could not reach the signaling server. Check your connection and try again.';
    case 'browser-incompatible': return 'This browser does not support WebRTC.';
    case 'unavailable-id': return 'That room code is already in use.';
    default: return (err && err.message) || 'Connection error';
  }
}

/* ------------------------------------------------------------------ */

// opts: { mode: 'lan'|'online', name, info?, code?, create?: bool }
// handlers: { onLobby, onView, onError(msg, fatal), onStatus(text), onConn(state) }
export function createSession(opts, handlers) {
  const h = {
    onLobby() {}, onView() {}, onError() {}, onStatus() {}, onConn() {},
    ...handlers,
  };
  const call = (name, ...a) => { try { h[name](...a); } catch (e) { console.error(name, e); } };
  const mode = opts.mode === 'lan' ? 'lan' : 'online';
  const name = String(opts.name || 'Player').trim().slice(0, 16) || 'Player';
  const cid = clientId();
  const info = opts.info || null;

  let code = mode === 'online' ? normCode(opts.code) || null : null;
  let stopped = false;
  let isHost = false;
  let transport = null; // { send(msg), close(), local? }
  let connState = null;
  let everOpen = false;
  let attempt = 0;
  let retryTimer = null;
  let lastRx = 0;
  let lastPing = 0;
  let pingN = 0;
  let tickTimer = null;

  // online-host state
  let room = null;
  let hostPeer = null;
  let hostConns = null;
  let selfDeliver = null;
  // online-joiner state
  let peer = null;

  const setConn = (s) => { if (s !== connState) { connState = s; call('onConn', s); } };

  const joinUrl = () => {
    if (mode === 'lan') {
      const urls = (info && info.lanUrls) || [];
      return urls[0] || location.origin;
    }
    // Inside the minimaj app the page lives on 127.0.0.1, which friends can't
    // open: invite them to the public web version instead (opts.publicUrl).
    if (opts.publicUrl) return opts.publicUrl.replace(/#.*$/, '') + '#' + code;
    return location.origin + location.pathname + '#' + code;
  };

  /* ---------- the client side, shared by every transport ---------- */

  function onOpen(t) {
    if (t !== transport) return;
    lastRx = lastPing = Date.now();
    setConn('open');
    t.send({ t: 'hello', name, cid, ver: PROTO, host: mode === 'lan' ? !!(info && info.hostOk) : !!t.local });
  }

  function onMessage(t, msg) {
    if (t !== transport || stopped) return;
    lastRx = Date.now();
    if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return; } }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'lobby' && msg.lobby) {
      if (attempt) call('onStatus', 'Reconnected');
      attempt = 0; everOpen = true;
      isHost = !!msg.lobby.isHost;
      call('onLobby', { ...msg.lobby, mode, code, joinUrl: joinUrl(), lanUrls: mode === 'lan' ? ((info && info.lanUrls) || []) : [] });
    } else if (msg.t === 'view' && msg.view) {
      if (attempt) call('onStatus', 'Reconnected');
      attempt = 0; everOpen = true;
      isHost = !!msg.view.isHost;
      call('onView', msg.view);
    } else if (msg.t === 'error') {
      const fatal = !!msg.fatal;
      call('onError', String(msg.msg || 'Error'), fatal);
      if (fatal) stop();
    }
  }

  function onDrop(t, why) {
    if (t !== transport) return;
    transport = null;
    try { t.close(); } catch (e) { /* ignore */ }
    if (stopped) { setConn('closed'); return; }
    scheduleReconnect(why);
  }

  function scheduleReconnect(why) {
    if (stopped || retryTimer) return;
    const ms = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    setConn('reconnecting');
    call('onStatus', (why || 'Connection lost') + ' — reconnecting…');
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, ms);
  }

  function tick() {
    tickTimer = null;
    if (stopped) return;
    tickTimer = setTimeout(tick, TICK_MS);
    const t = transport;
    if (!t || connState !== 'open' || stopped) return;
    const now = Date.now();
    if (now - lastPing >= PING_MS) { lastPing = now; t.send({ t: 'ping', n: ++pingN }); }
    if (!t.local && now - lastRx > DEAD_MS) onDrop(t, 'No answer from the host');
  }

  function onVisible() {
    if (document.visibilityState !== 'visible' || stopped) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; connect(); return; }
    const t = transport;
    if (t && connState === 'open') {
      if (!t.local && Date.now() - lastRx > DEAD_MS) onDrop(t, 'Connection lost');
      else { lastPing = Date.now(); t.send({ t: 'ping', n: ++pingN }); }
    }
  }

  function send(msg) {
    if (transport && connState === 'open') transport.send(msg);
  }

  function connect() {
    if (stopped) return;
    if (!connState) setConn('connecting');
    if (mode === 'lan') connectWs();
    else if (opts.create) connectSelf();
    else connectPeer();
  }

  /* ---------- LAN: WebSocket to the native server ---------- */

  function connectWs() {
    let ws;
    const t = {
      send(m) { try { if (ws.readyState === 1) ws.send(JSON.stringify(m)); } catch (e) { /* ignore */ } },
      close() { try { ws.close(); } catch (e) { /* ignore */ } },
    };
    transport = t;
    try {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    } catch (e) {
      onDrop(t, 'Could not connect');
      return;
    }
    const timer = setTimeout(() => { if (ws.readyState !== 1) onDrop(t, 'Could not connect'); }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => { clearTimeout(timer); onOpen(t); };
    ws.onmessage = (e) => onMessage(t, e.data);
    ws.onclose = () => { clearTimeout(timer); onDrop(t, 'Connection lost'); };
    ws.onerror = () => {};
  }

  /* ---------- online, creator: run the room in this tab ---------- */

  function connectSelf() {
    if (!room) { startHost(); return; }
    const t = {
      local: true,
      send(m) { const copy = JSON.parse(JSON.stringify(m)); queueMicrotask(() => { if (transport === t && room) room.message('self', copy); }); },
      close() { if (room) room.closed('self'); },
    };
    transport = t;
    selfDeliver = (m) => onMessage(t, m);
    room.open('self', { hostOk: true });
    queueMicrotask(() => onOpen(t));
  }

  function startHost() {
    hostConns = new Map();
    let nextId = 1;
    room = createRoom({
      send(id, m) {
        if (id === 'self') { const copy = JSON.parse(JSON.stringify(m)); queueMicrotask(() => { if (selfDeliver) selfDeliver(copy); }); return; }
        const c = hostConns.get(id);
        try { if (c && c.open) c.send(m); } catch (e) { /* ignore */ }
      },
      close(id) {
        if (id === 'self') {
          // the room dropped our own seat (it thought we were gone): rejoin
          queueMicrotask(() => { const t = transport; if (t && t.local) onDrop(t, 'Rejoining'); });
          return;
        }
        const c = hostConns.get(id);
        hostConns.delete(id);
        try { if (c) c.close(); } catch (e) { /* ignore */ }
      },
      now: () => Date.now(),
      log: () => {},
    });
    const tryOpen = (n, fixed) => {
      if (stopped) return;
      const c = fixed || makeCode();
      const p = new window.Peer(PREFIX + c);
      let opened = false;
      hostPeer = p;
      p.on('open', () => {
        opened = true;
        code = c;
        storageSet('sessionStorage', 'minimaj-host-code', c);
        connectSelf();
      });
      p.on('connection', (conn) => {
        const id = 'p' + nextId++;
        hostConns.set(id, conn);
        conn.on('open', () => { if (room) room.open(id, { hostOk: false }); });
        conn.on('data', (d) => { if (room) room.message(id, d); });
        const gone = () => { if (hostConns.get(id) === conn) hostConns.delete(id); if (room) room.closed(id); };
        conn.on('close', gone);
        conn.on('error', gone);
      });
      p.on('disconnected', () => {
        // lost the signaling server: running games keep working; retry quietly
        if (stopped) return;
        setTimeout(() => { try { if (!stopped && p.disconnected && !p.destroyed) p.reconnect(); } catch (e) { /* ignore */ } }, 2000);
      });
      p.on('error', (err) => {
        if (stopped) return;
        if (err && err.type === 'unavailable-id' && !opened && n < 5) { try { p.destroy(); } catch (e) { /* ignore */ } tryOpen(n + 1); return; }
        if (err && err.type === 'peer-unavailable') return;
        if (!opened) { call('onError', peerErrorText(err), true); stop(); return; }
        call('onStatus', peerErrorText(err));
      });
    };
    loadPeerJS().then(() => {
      const wanted = code || normCode(storageGet('sessionStorage', 'minimaj-host-code'));
      tryOpen(0, wanted && wanted.length === 5 ? wanted : null);
    }, (e) => { call('onError', e.message, true); stop(); });
  }

  /* ---------- online, joiner: PeerJS data channel to the host ---------- */

  function connectPeer() {
    if (!code || code.length !== 5) { call('onError', 'Enter the 5-character room code.', true); stop(); return; }
    let conn = null;
    const t = {
      send(m) { try { if (conn && conn.open) conn.send(m); } catch (e) { /* ignore */ } },
      close() { try { if (conn) conn.close(); } catch (e) { /* ignore */ } },
    };
    transport = t;
    const timer = setTimeout(() => { if (transport === t && connState !== 'open') onDrop(t, 'Could not reach the host'); }, CONNECT_TIMEOUT_MS);
    const dial = () => {
      if (transport !== t) return;
      conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      conn.on('open', () => { clearTimeout(timer); onOpen(t); });
      conn.on('data', (d) => onMessage(t, d));
      conn.on('close', () => { clearTimeout(timer); onDrop(t, 'Connection lost'); });
      conn.on('error', () => { clearTimeout(timer); onDrop(t, 'Connection lost'); });
    };
    loadPeerJS().then(() => {
      if (transport !== t) return;
      if (peer && !peer.destroyed && !peer.disconnected && peer.open) { dial(); return; }
      if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } }
      const p = new window.Peer();
      peer = p;
      p.on('open', () => { if (peer === p) dial(); });
      p.on('error', (err) => {
        if (peer !== p || stopped) return;
        const tt = transport;
        if (err && err.type === 'peer-unavailable' && !everOpen) {
          clearTimeout(timer);
          call('onError', peerErrorText(err), true);
          stop();
          return;
        }
        if (tt) { clearTimeout(timer); onDrop(tt, peerErrorText(err)); }
      });
      p.on('disconnected', () => { /* data channels survive; a new Peer is made on the next reconnect */ });
    }, (e) => { call('onError', e.message, true); stop(); });
  }

  /* ---------- lifecycle ---------- */

  function stop() {
    if (stopped) return;
    stopped = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
    try { document.removeEventListener('visibilitychange', onVisible); } catch (e) { /* ignore */ }
    const t = transport;
    transport = null;
    if (t) { try { t.close(); } catch (e) { /* ignore */ } }
    if (room) { try { room.destroy(); } catch (e) { /* ignore */ } room = null; }
    if (hostPeer) { try { hostPeer.destroy(); } catch (e) { /* ignore */ } hostPeer = null; }
    if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } peer = null; }
    setConn('closed');
  }

  try { document.addEventListener('visibilitychange', onVisible); } catch (e) { /* ignore */ }
  tickTimer = setTimeout(tick, TICK_MS);
  connect();

  return {
    mode,
    cid,
    get isHost() { return isHost; },
    get code() { return code; },
    act(a) { send({ t: 'act', a }); },
    start() { send({ t: 'lobby-cmd', cmd: 'start' }); },
    setSettings(s) { send({ t: 'lobby-cmd', cmd: 'settings', settings: s }); },
    backToLobby() { send({ t: 'lobby-cmd', cmd: 'lobby' }); },
    close() { stop(); },
  };
}
