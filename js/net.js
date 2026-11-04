// Session layer: connects the UI to a room (js/room.js).
//   LAN mode:    the room runs in the native server; we talk over a WebSocket.
//   Online mode: the creator's tab runs the room itself (its own UI is the
//                in-page connection 'self'); others connect over WebRTC data
//                channels set up by PeerJS (loaded on demand). ICE/TURN and
//                signaling settings live in js/config.js.
// Both client kinds send a ping every 3 s; 9 s without any message means the
// link is dead, and we reconnect with backoff using the same client id, so the
// room hands our seat back. A joiner that has never got in gives up after a
// few tries with a message that says what failed (room server, host, or a
// network that blocks peer-to-peer connections) instead of spinning forever.
import { createRoom, PROTO } from './room.js';
import { NET_CONFIG } from './config.js';

const PREFIX = 'minimaj-v1-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PING_MS = 3000;
const DEAD_MS = 9000;
const TICK_MS = 1000;
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const CONNECT_TIMEOUT_MS = 12000;
const FIRST_TRIES = 3; // online joiner: failed attempts before giving up (never connected yet)
const SIGNAL_TRIES = 3; // online host: room-server failures before giving up on opening a room
const RECLAIM_MS = 60000; // online host after a reload: keep asking for the old code this long
const RECLAIM_EVERY_MS = 3000;
const HOST_RECONNECT_MS = [1000, 2000, 4000, 8000, 15000];
const ICE_TIMEOUT_MS = 4000;
const ICE_CACHE_MS = 10 * 60 * 1000;

export const makeCode = () => Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
export const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

// Why a (normalized) room code can't be right, or null if it can.
export function codeProblem(c) {
  const s = String(c || '');
  if (s.length !== 5) return 'Enter the 5-character room code.';
  if (/[IO01]/.test(s)) return 'Room codes never contain I, O, 0 or 1 — check the code again.';
  return null;
}

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
// Pages from the app are plain http on a local address; give a busy phone
// server more time there (a miss would show the wrong home screen).
export async function detectServer() {
  const local = typeof location !== 'undefined' && location.protocol === 'http:';
  for (const ms of local ? [2000, 5000] : [1500]) {
    const r = await fetchJson('/info.json', ms);
    if (r.ok) return r.data && r.data.server === true ? r.data : null;
    if (r.status) return null; // the server answered: not a minimaj app (e.g. 404)
  }
  return null;
}

async function fetchJson(url, ms, init) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, ms);
  try {
    const r = await fetch(url, { cache: 'no-store', ...init, signal: ctrl ? ctrl.signal : undefined });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, status: r.status, data: await r.json() };
  } catch (e) {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- configuration (js/config.js, window.MINIMAJ_NET) ---------- */

export function netConfig() {
  const o = (typeof window !== 'undefined' && window.MINIMAJ_NET && typeof window.MINIMAJ_NET === 'object') ? window.MINIMAJ_NET : {};
  return { ...NET_CONFIG, ...o };
}

const validIce = (s) => !!s && typeof s === 'object' && (typeof s.urls === 'string' || (Array.isArray(s.urls) && s.urls.length > 0) || typeof s.url === 'string');

// Accepts what TURN credential APIs return: [servers], {iceServers: [...]}
// or {iceServers: {...}} (Cloudflare), and drops anything malformed.
export function parseIceResponse(j) {
  let a = Array.isArray(j) ? j : j && typeof j === 'object' ? (j.iceServers || j.ice_servers || j.v && j.v.iceServers) : null;
  if (a && !Array.isArray(a) && typeof a === 'object') a = [a];
  return Array.isArray(a) ? a.filter(validIce) : [];
}

export const hasTurn = (list) => (list || []).some((s) => [].concat(s.urls || s.url || []).some((u) => /^turns?:/i.test(String(u))));

let iceCache = null; // { at, list }
export async function iceServers() {
  const cfg = netConfig();
  const fixed = Array.isArray(cfg.iceServers) ? cfg.iceServers.filter(validIce) : [];
  if (!cfg.iceUrl) return fixed;
  if (!iceCache || Date.now() - iceCache.at > ICE_CACHE_MS) {
    const r = await fetchJson(String(cfg.iceUrl), ICE_TIMEOUT_MS);
    const list = r.ok ? parseIceResponse(r.data) : [];
    if (list.length) iceCache = { at: Date.now(), list };
    else { try { console.warn('minimaj: could not get ICE servers from iceUrl'); } catch (e) { /* ignore */ } }
  }
  return (iceCache ? iceCache.list : []).concat(fixed);
}

async function peerOptions() {
  const cfg = netConfig();
  const servers = await iceServers();
  // PeerJS's built-in defaults point at TURN servers that no longer exist, so
  // always pass our own list (it replaces PeerJS's config entirely).
  return { debug: 0, ...(cfg.peer && typeof cfg.peer === 'object' ? cfg.peer : {}), config: { iceServers: servers, sdpSemantics: 'unified-plan' } };
}

let peerJsPromise = null;
function loadPeerJS() {
  if (typeof window.Peer === 'function') return Promise.resolve(window.Peer);
  if (!peerJsPromise) {
    peerJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('./vendor/peerjs.min.js', import.meta.url).href;
      s.async = true;
      s.onload = () => (typeof window.Peer === 'function' ? resolve(window.Peer) : reject(new Error('Could not load the online-room code. Please reload.')));
      s.onerror = () => { peerJsPromise = null; reject(new Error('Could not load the online-room code. Check your connection and reload.')); };
      document.head.appendChild(s);
    });
  }
  return peerJsPromise;
}

const hasWebRTC = () => typeof window !== 'undefined' && typeof (window.RTCPeerConnection || window.webkitRTCPeerConnection) === 'function';

const MSG = {
  browser: 'This browser cannot make peer-to-peer (WebRTC) connections, which online rooms need. '
    + 'If you opened the link inside another app (chat, social media), open it in Chrome, Safari or Firefox instead.',
  signal: 'Could not reach the online-room server (0.peerjs.com). Check your internet connection — some school, office and public networks block it. Try another network.',
  notFound: (c) => `No room with the code ${c}. Check the code. The host must keep the room open (on a phone: the app or tab in front, screen on).`,
  ice: 'Could not connect to the host: a network on one side blocks direct peer-to-peer connections. '
    + 'This is common on mobile data and on office, school or hotel Wi-Fi. Try another network (for example both on home Wi-Fi), or ask the host to set up a TURN relay.',
  noAnswer: 'The host did not answer. Ask them to keep the minimaj room open and on screen, then try again.',
};

function peerErrorText(err, c) {
  switch (err && err.type) {
    case 'peer-unavailable': return MSG.notFound(c || '');
    case 'network': case 'server-error': case 'socket-error': case 'socket-closed': return MSG.signal;
    case 'browser-incompatible': return MSG.browser;
    case 'unavailable-id': return 'That room code is already in use.';
    case 'negotiation-failed': case 'webrtc': return MSG.ice;
    default: return (err && err.message) || 'Connection error';
  }
}
const isSignalErr = (err) => ['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(err && err.type);

/* ------------------------------------------------------------------ */

// opts: { mode: 'lan'|'online', name, info?, code?, create?: bool, publicUrl? }
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
  let firstFails = 0;
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
  let hostOpened = false; // the room's code is registered (at least once)
  let hostRetry = 0; // reconnects to the room server since it was last open
  let hostRetryAt = 0;
  let hostSignalNoted = false;
  // online-joiner state
  let peer = null;

  const setConn = (s) => { if (s !== connState) { connState = s; call('onConn', s); } };
  const fail = (msg) => { call('onError', msg, true); stop(); };

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

  function gotIn() {
    if (attempt) call('onStatus', 'Reconnected');
    attempt = 0; firstFails = 0; everOpen = true;
  }

  function onMessage(t, msg) {
    if (t !== transport || stopped) return;
    lastRx = Date.now();
    if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return; } }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'lobby' && msg.lobby) {
      gotIn();
      isHost = !!msg.lobby.isHost;
      call('onLobby', { ...msg.lobby, mode, code, joinUrl: joinUrl(), lanUrls: mode === 'lan' ? ((info && info.lanUrls) || []) : [] });
    } else if (msg.t === 'view' && msg.view) {
      gotIn();
      isHost = !!msg.view.isHost;
      call('onView', msg.view);
    } else if (msg.t === 'error') {
      const fatal = !!msg.fatal;
      call('onError', String(msg.msg || 'Error'), fatal);
      if (fatal) stop();
    }
  }

  // why: text for the status line; fatalText: what to say if we give up now
  function onDrop(t, why, fatalText) {
    if (t !== transport) return;
    transport = null;
    try { t.close(); } catch (e) { /* ignore */ }
    if (stopped) { setConn('closed'); return; }
    if (!everOpen && mode === 'online' && !opts.create && ++firstFails >= FIRST_TRIES) {
      fail(fatalText || why || 'Could not connect');
      return;
    }
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
    hostSignalCheck(false);
    const t = transport;
    if (!t || connState !== 'open' || stopped) return;
    const now = Date.now();
    if (now - lastPing >= PING_MS) { lastPing = now; t.send({ t: 'ping', n: ++pingN }); }
    if (!t.local && now - lastRx > DEAD_MS) onDrop(t, 'No answer from the host');
  }

  function onVisible() {
    if (document.visibilityState !== 'visible' || stopped) return;
    hostSignalCheck(true);
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
    if (!hostOpened) return; // the code is not registered yet: hostOpen() joins us
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
    if (!hasWebRTC()) { fail(MSG.browser); return; }
    Promise.all([loadPeerJS(), peerOptions()]).then(([, popts]) => {
      if (stopped) return;
      const saved = normCode(storageGet('sessionStorage', 'minimaj-host-code'));
      const wanted = code || (codeProblem(saved) ? null : saved);
      openHostPeer(popts, wanted, Date.now(), 0, 0);
    }, (e) => fail(e.message));
  }

  let nextConnId = 1;
  function acceptConn(conn) {
    const id = 'p' + nextConnId++;
    hostConns.set(id, conn);
    conn.on('open', () => { if (room && hostConns.get(id) === conn) room.open(id, { hostOk: false }); });
    conn.on('data', (d) => {
      if (!room || hostConns.get(id) !== conn) return;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
      room.message(id, d);
    });
    const gone = () => {
      if (hostConns.get(id) !== conn) return;
      hostConns.delete(id);
      try { conn.close(); } catch (e) { /* ignore */ }
      if (room) room.closed(id);
    };
    conn.on('close', gone);
    conn.on('error', (err) => {
      // one message that was too big is not a dead connection
      if (err && err.type === 'message-too-big') { try { console.warn('minimaj: message too big'); } catch (e) { /* ignore */ } return; }
      gone();
    });
  }

  // wanted: the code to (re)claim, or null for a new random one.
  // since: when we started asking for `wanted`; collisions: random codes taken.
  function openHostPeer(popts, wanted, since, collisions, signalFails) {
    if (stopped) return;
    const c = wanted || makeCode();
    let p;
    try { p = new window.Peer(PREFIX + c, popts); } catch (e) { fail(MSG.browser); return; }
    hostPeer = p;
    let opened = false;
    const retire = () => { try { p.destroy(); } catch (e) { /* ignore */ } };
    p.on('open', () => {
      if (hostPeer !== p || stopped) return;
      hostRetry = 0; hostRetryAt = 0;
      if (hostSignalNoted) { hostSignalNoted = false; call('onStatus', 'Back online — friends can join again'); }
      if (opened) return; // reconnected to the room server
      opened = true;
      code = c;
      storageSet('sessionStorage', 'minimaj-host-code', c);
      hostOpened = true;
      connectSelf();
    });
    p.on('connection', acceptConn);
    p.on('disconnected', () => {
      // lost the room server: running games keep working; tick() reconnects
      if (hostPeer !== p || stopped || !opened) return;
      if (!hostRetryAt) hostRetryAt = Date.now() + HOST_RECONNECT_MS[0];
    });
    p.on('error', (err) => {
      if (hostPeer !== p || stopped) return;
      const type = err && err.type;
      if (type === 'peer-unavailable') return;
      if (opened) {
        // after the room is up: only tell the host once per outage
        if (isSignalErr(err) || type === 'unavailable-id') {
          if (!hostSignalNoted) { hostSignalNoted = true; call('onStatus', 'Lost the online-room server — the game goes on, but new players can\'t join until it is back'); }
          return;
        }
        call('onStatus', peerErrorText(err, code));
        return;
      }
      retire();
      if (type === 'unavailable-id') {
        if (wanted && Date.now() - since < RECLAIM_MS) {
          // After a reload the server may still hold our old code for a while:
          // keep it, so the link friends already have keeps working.
          if (!code) code = wanted;
          call('onStatus', `Waiting for room code ${wanted}…`);
          setTimeout(() => openHostPeer(popts, wanted, since, collisions, signalFails), RECLAIM_EVERY_MS);
        } else if (collisions < 5) {
          if (wanted) call('onStatus', `Room code ${wanted} is still in use, so this room gets a new code`);
          openHostPeer(popts, null, Date.now(), collisions + 1, signalFails);
        } else fail('Could not get a room code. Please try again.');
        return;
      }
      if (isSignalErr(err) && signalFails + 1 < SIGNAL_TRIES) {
        call('onStatus', 'Could not reach the online-room server — retrying…');
        setTimeout(() => openHostPeer(popts, wanted, since, collisions, signalFails + 1), 1500 * (signalFails + 1));
        return;
      }
      fail(peerErrorText(err, c));
    });
  }

  // Keep the host's registration with the room server alive (backoff), and
  // retry at once when the tab comes back to the front.
  function hostSignalCheck(now) {
    const p = hostPeer;
    if (!p || !hostOpened || stopped || p.destroyed || !p.disconnected) return;
    if (!now && hostRetryAt && Date.now() < hostRetryAt) return;
    hostRetryAt = Date.now() + HOST_RECONNECT_MS[Math.min(hostRetry, HOST_RECONNECT_MS.length - 1)];
    hostRetry++;
    try { p.reconnect(); } catch (e) { /* ignore */ }
  }

  /* ---------- online, joiner: PeerJS data channel to the host ---------- */

  function connectPeer() {
    const bad = codeProblem(code);
    if (bad) { fail(bad); return; }
    if (!hasWebRTC()) { fail(MSG.browser); return; }
    let conn = null;
    let stage = 'load'; // load -> signal (waiting for the room server) -> dial (waiting for the host)
    let ice = 'new';
    const t = {
      send(m) { try { if (conn && conn.open) conn.send(m); } catch (e) { /* ignore */ } },
      close() { try { if (conn) conn.close(); } catch (e) { /* ignore */ } },
    };
    transport = t;
    // what went wrong if this attempt never opens
    const failText = () => {
      if (stage !== 'dial') return MSG.signal;
      const st = (conn && conn.peerConnection && conn.peerConnection.iceConnectionState) || ice;
      return st === 'new' ? MSG.noAnswer : MSG.ice;
    };
    const drop = (why) => { clearTimeout(timer); onDrop(t, why, failText()); };
    const timer = setTimeout(() => {
      if (transport !== t || connState === 'open') return;
      drop(stage === 'dial' ? 'Could not reach the host' : 'Could not reach the online-room server');
    }, CONNECT_TIMEOUT_MS);
    const dial = () => {
      if (transport !== t) return;
      stage = 'dial';
      try { conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' }); } catch (e) { drop('Could not reach the host'); return; }
      if (!conn) { drop('Could not reach the host'); return; }
      conn.on('open', () => { clearTimeout(timer); onOpen(t); });
      conn.on('data', (d) => onMessage(t, d));
      conn.on('iceStateChanged', (s) => { ice = s; });
      conn.on('close', () => drop('Connection lost'));
      conn.on('error', (err) => {
        if (err && err.type === 'message-too-big') return;
        if (err && err.type === 'negotiation-failed' && connState !== 'open') ice = 'failed';
        drop(connState === 'open' ? 'Connection lost' : 'Could not connect to the host');
      });
    };
    Promise.all([loadPeerJS(), peerOptions()]).then(([, popts]) => {
      if (transport !== t) return;
      stage = 'signal';
      if (peer && !peer.destroyed && !peer.disconnected && peer.open) { dial(); return; }
      if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } }
      let p;
      try { p = new window.Peer(popts); } catch (e) { clearTimeout(timer); fail(MSG.browser); return; }
      peer = p;
      p.on('open', () => { if (peer === p) dial(); });
      p.on('error', (err) => {
        if (peer !== p || stopped) return;
        const tt = transport;
        const type = err && err.type;
        if (type === 'browser-incompatible') { clearTimeout(timer); fail(MSG.browser); return; }
        if (type === 'peer-unavailable') {
          if (!everOpen) { clearTimeout(timer); fail(MSG.notFound(code)); return; }
          if (tt) { clearTimeout(timer); onDrop(tt, 'The host is away'); }
          return;
        }
        // Losing the room server does not break an open data channel: keep
        // playing; a new Peer is made if we ever need to reconnect.
        if (isSignalErr(err) && tt && connState === 'open') return;
        if (tt) { clearTimeout(timer); onDrop(tt, isSignalErr(err) ? 'Could not reach the online-room server' : peerErrorText(err, code), peerErrorText(err, code)); }
      });
      p.on('disconnected', () => { /* data channels survive; see above */ });
    }, (e) => { clearTimeout(timer); fail(e.message); });
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
