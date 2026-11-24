// Session layer: connects the UI to a room (js/room.js).
//   LAN mode:    the room runs in the native server; we talk over a WebSocket.
//   Online mode: the creator's tab runs the room itself (its own UI is the
//                in-page connection 'self'); others connect over WebRTC data
//                channels. The connection is set up through two kinds of
//                signaling at once: the PeerJS server (loaded on demand) and
//                several public MQTT brokers (js/rendezvous.js); the first
//                route that opens a channel wins, so one blocked or flaky
//                server locks nobody out. ICE/TURN and signaling settings
//                live in js/config.js.
// Both client kinds send a ping every 3 s; 20 s without any message means the
// link is dead, and we reconnect with backoff using the same client id, so the
// room hands our seat back. A joiner that has never got in gives up after a
// few tries with a message that says what failed (room server, host, or a
// network that blocks peer-to-peer connections) instead of spinning forever.
import { createRoom, PROTO, EMOTES, emoteAllowed } from './room.js';
import { NET_CONFIG } from './config.js';
import { hostRendezvous, dialRendezvous } from './rendezvous.js';

const PREFIX = 'minimaj-v1-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PING_MS = 3000;
const DEAD_MS = 20000; // phones on 4G + VPN can stall for many seconds without being gone
const TICK_MS = 1000;
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const CONNECT_TIMEOUT_MS = 12000; // per attempt; grows on reconnects (connectTimeout)
const STARVED_MS = 5000; // tick() late by this much: the tab was frozen, not the link
const WARN_AFTER = 5; // reconnect attempts before the status names the real reason
const HOST_REFRESH_MS = 4 * 60 * 1000; // re-register with the PeerJS server this often
const HIDDEN_REFRESH_MS = 20000; // ... and after the tab was hidden this long
const HALF_OPEN_MS = 30000; // online host: a connection not open by then is dropped
const FIRST_TRIES = 3; // online joiner: failed attempts before giving up (never connected yet)
const SIGNAL_TRIES = 3; // online host: room-server failures before giving up on opening a room
const RECLAIM_MS = 60000; // online host after a reload: keep asking for the old code this long
const RECLAIM_EVERY_MS = 3000;
const HOST_RECONNECT_MS = [1000, 2000, 4000, 8000, 15000];
const HOST_PEER_WAIT_MS = 15000; // online host: a PeerJS registration unanswered this long has failed (blackholed server)
const HOST_MQTT_WAIT_MS = 10000; // online host: after PeerJS gave up, wait this long for an MQTT broker

// A view comes from the host, which may be another player's modified browser: force
// the numbers the UI draws to be numbers in range, and known words to known words, so
// nothing from it can turn into markup or freeze the page (the UI escapes text too).
const int = (x, lo, hi) => Math.min(hi, Math.max(lo, Math.trunc(Number(x)) || 0));
export function saneView(v) {
  for (const k of ['seat', 'dealer', 'turn']) v[k] = int(v[k], 0, 3);
  for (const k of ['round', 'kyoku']) v[k] = int(v[k], 0, 3);
  for (const k of ['honba', 'sticks']) v[k] = int(v[k], 0, 99);
  v.wall = int(v.wall, 0, 136);
  if (!Array.isArray(v.players) || v.players.length !== 4) v.players = [0, 1, 2, 3].map(() => ({}));
  for (const p of v.players) {
    if (!p || typeof p !== 'object') continue;
    p.handCount = int(p.handCount, 0, 14);
    p.score = int(p.score, -1e7, 1e7);
  }
  const r = v.result;
  if (r && typeof r === 'object') {
    r.type = r.type === 'tsumo' || r.type === 'ron' ? r.type : 'draw';
    r.honba = int(r.honba, 0, 99);
    r.sticks = int(r.sticks, 0, 99);
  }
  return v;
}
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

// The room code this device last hosted (kept on the device, not only in the tab):
// "Create room" asks for it again, and joining it when nobody hosts it reopens it,
// so friends' links keep working after the host's app or tab was closed.
const HOSTED_KEY = 'minimaj-hosted';
const HOSTED_MS = 6 * 3600 * 1000;
export function lastHostedCode() {
  try {
    const h = JSON.parse(storageGet('localStorage', HOSTED_KEY) || 'null');
    const c = h && normCode(h.c);
    return c && !codeProblem(c) && Date.now() - h.at < HOSTED_MS ? c : null;
  } catch (e) { return null; }
}
function rememberHosted(c) { storageSet('localStorage', HOSTED_KEY, JSON.stringify({ c, at: Date.now() })); }

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

// The MQTT route's settings, or null when it can't run here (no brokers
// configured, no WebSocket, or no WebCrypto: pages on plain http:// over the
// network are not a secure context).
function mqttRoute() {
  const cfg = netConfig();
  const brokers = Array.isArray(cfg.mqtt) ? cfg.mqtt.filter((u) => typeof u === 'string' && /^wss?:\/\//i.test(u)) : [];
  const WS = typeof window !== 'undefined' ? window.WebSocket : null;
  const RTC = typeof window !== 'undefined' ? (window.RTCPeerConnection || window.webkitRTCPeerConnection) : null;
  const crypto = globalThis.crypto;
  if (!brokers.length || typeof WS !== 'function' || typeof RTC !== 'function' || !crypto || !crypto.subtle) return null;
  return { brokers, WebSocket: WS, RTCPeerConnection: RTC };
}
const usePeerJS = () => netConfig().peerjs !== false;

const hasWebRTC = () => typeof window !== 'undefined' && typeof (window.RTCPeerConnection || window.webkitRTCPeerConnection) === 'function';

const MSG = {
  browser: 'This browser cannot make peer-to-peer (WebRTC) connections, which online rooms need. '
    + 'If you opened the link inside another app (chat, social media), open it in Chrome, Safari or Firefox instead.',
  signal: 'Could not reach any online-room server. Check your internet connection — some school, office and public networks block them. Try another network.',
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
// handlers: { onLobby, onView, onError(msg, fatal), onStatus(text), onConn(state),
//             onEmote({ seat, member?, e, n }) }
export function createSession(opts, handlers) {
  const h = {
    onLobby() {}, onView() {}, onError() {}, onStatus() {}, onConn() {}, onEmote() {},
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
  let lastTick = Date.now(); // when tick() last ran (a big gap: our timers were frozen)
  let hiddenAt = 0;
  const emoteTimes = []; // our own recent emotes: the room's rate limit, applied before sending

  // online-host state
  let room = null;
  let hostPeer = null;
  let hostConns = null;
  let selfDeliver = null;
  let hostOpened = false; // the room's code is settled and players may join
  let hostedAt = 0; // when the hosted code was last remembered (lastHostedCode)
  let hostRetry = 0; // reconnects to the room server since it was last open
  let hostRetryAt = 0;
  let hostSignalNoted = false;
  let hostPopts = null; // PeerJS options (ICE servers)
  let hostRdv = null; // MQTT signaling (js/rendezvous.js), or null when unavailable
  let peerUp = false; // registered with the PeerJS server right now
  let hostOpenedAt = 0;
  let codeTakenNoted = false;
  let peerGaveUp = false; // PeerJS could not open the room (or is turned off)
  let peerRetryTimer = null;
  let mqttWait = null;
  let hostRefreshedAt = 0;
  let peerRefreshing = false; // a deliberate disconnect + reconnect (hostSignalRefresh)
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
    } else if (msg.t === 'view' && msg.view && typeof msg.view === 'object') {
      gotIn();
      isHost = !!msg.view.isHost;
      call('onView', saneView(msg.view));
    } else if (msg.t === 'emote') {
      if (EMOTES.indexOf(msg.e) >= 0 && Number.isInteger(msg.seat)) {
        const ev = { seat: msg.seat, e: msg.e, n: typeof msg.n === 'number' ? msg.n : 0 };
        if (Number.isInteger(msg.member)) ev.member = msg.member;
        call('onEmote', ev);
      }
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
    scheduleReconnect(why, fatalText);
  }

  function scheduleReconnect(why, fatalText) {
    if (stopped || retryTimer) return;
    const ms = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    setConn('reconnecting');
    // after a few silent failures, say what is actually wrong (and keep trying)
    call('onStatus', everOpen && attempt >= WARN_AFTER && fatalText ? fatalText + ' Still trying…' : (why || 'Connection lost') + ' — reconnecting…');
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, ms);
  }

  // One attempt's time limit: longer on each reconnect once we have been in,
  // so slow VPN / TURN paths are not always cut short.
  const connectTimeout = () => (everOpen ? Math.min(30000, CONNECT_TIMEOUT_MS + 6000 * attempt) : CONNECT_TIMEOUT_MS);

  // reconnect now (a "Rejoin" button, the network came back): skips the backoff wait
  function retryNow() {
    if (stopped || !retryTimer) return false;
    clearTimeout(retryTimer); retryTimer = null;
    connect();
    return true;
  }

  const ping = (t) => { lastPing = Date.now(); t.send({ t: 'ping', n: ++pingN }); };

  function tick() {
    tickTimer = null;
    if (stopped) return;
    tickTimer = setTimeout(tick, TICK_MS);
    const now = Date.now();
    const starved = now - lastTick > STARVED_MS;
    lastTick = now;
    hostSignalCheck(false);
    if (hostOpened && now - hostRefreshedAt > HOST_REFRESH_MS) hostSignalRefresh();
    // still hosting: keep the remembered code fresh
    if (hostOpened && code && Date.now() - hostedAt > 60000) { rememberHosted(code); hostedAt = Date.now(); }
    const t = transport;
    if (!t || connState !== 'open' || stopped) return;
    // our own timers were frozen (background tab, sleeping phone): the silence
    // says nothing about the link, so ask again instead of dropping it
    if (starved && !t.local) { lastRx = now; ping(t); return; }
    if (now - lastPing >= PING_MS) ping(t);
    if (!t.local && now - lastRx > DEAD_MS) onDrop(t, 'Connection lost');
  }

  function onVisible() {
    if (document.visibilityState !== 'visible') { hiddenAt = Date.now(); return; }
    if (stopped) return;
    const hiddenFor = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (hiddenFor > HIDDEN_REFRESH_MS) hostSignalRefresh();
    hostSignalCheck(true);
    if (retryNow()) return;
    const t = transport;
    if (t && connState === 'open') {
      ping(t);
      // back from the background: give the link a few seconds to answer
      if (!t.local && Date.now() - lastRx > DEAD_MS - 4000) lastRx = Date.now() - DEAD_MS + 4000;
    }
  }

  // The network changed (back online, Wi-Fi <-> mobile data, VPN): links made
  // over the old one may be dead without noticing. Check at once.
  function onNetChange() {
    if (stopped) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    hostSignalRefresh();
    if (retryNow()) return;
    const t = transport;
    if (t && connState === 'open' && !t.local) ping(t);
  }
  const netConn = () => (typeof navigator !== 'undefined' && navigator.connection && typeof navigator.connection.addEventListener === 'function' ? navigator.connection : null);
  function listenNet(on) {
    const m = on ? 'addEventListener' : 'removeEventListener';
    try { if (typeof window !== 'undefined' && typeof window[m] === 'function') window[m]('online', onNetChange); } catch (e) { /* ignore */ }
    try { const c = netConn(); if (c) c[m]('change', onNetChange); } catch (e) { /* ignore */ }
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
    const saved = normCode(storageGet('sessionStorage', 'minimaj-host-code'));
    const wanted = code || (codeProblem(saved) ? null : saved) || lastHostedCode();
    const first = wanted || makeCode();
    // Whichever answers first opens the room: an MQTT broker (the room opens at
    // once with this code; PeerJS registers it in the background) or the
    // PeerJS server (it settles the code: reclaim after a reload, collisions).
    // Waiting for PeerJS would stall every room when its server is blocked.
    ensureRdv(first);
    if (!usePeerJS()) { peerGaveUp = true; hostFallback(MSG.signal); return; }
    Promise.all([loadPeerJS(), peerOptions()]).then(([, popts]) => {
      if (stopped) return;
      hostPopts = popts;
      openHostPeer(first, !!wanted, Date.now(), 0, 0);
    }, (e) => { peerGaveUp = true; hostFallback(e.message); });
  }

  // the room's code is settled (by PeerJS, or by the MQTT route alone): let players in
  function hostOpen(c) {
    if (hostOpened || stopped) return;
    if (mqttWait) { clearTimeout(mqttWait); mqttWait = null; }
    code = c;
    storageSet('sessionStorage', 'minimaj-host-code', c);
    rememberHosted(c); hostedAt = Date.now();
    hostOpened = true;
    hostOpenedAt = hostRefreshedAt = Date.now();
    ensureRdv(c);
    if (hostRdv) hostRdv.active = true;
    connectSelf();
    // opened without PeerJS: keep trying to register there too, for players
    // whose MQTT route is blocked (and older versions, which only use PeerJS)
    if (peerGaveUp && !hostPeer) retryHostPeer();
  }

  // MQTT signaling for the code c (the candidate until hostOpen, then the room's)
  function ensureRdv(c) {
    if (hostRdv && hostRdv.code === c) return;
    if (hostRdv) hostRdv.close();
    hostRdv = null;
    const rt = mqttRoute();
    if (!rt) return;
    hostRdv = hostRendezvous({
      code: c,
      ...rt,
      iceServers,
      onConnection: (conn) => { if (hostOpened && !stopped) acceptConn(conn); else conn.close(); },
      onStatus: () => { if (!tryMqttOpen()) hostRoutes(); },
    });
  }

  // Open the room on the MQTT route as soon as a broker is up.
  function tryMqttOpen() {
    if (hostOpened || stopped || !hostRdv || !hostRdv.brokersUp) return false;
    hostOpen(hostRdv.code);
    return true;
  }

  // PeerJS can't open the room: the MQTT route alone, or give up if it can't either
  function hostFallback(text) {
    if (hostOpened || stopped) return;
    if (tryMqttOpen()) return;
    if (!hostRdv) { fail(text || MSG.signal); return; }
    if (!mqttWait) mqttWait = setTimeout(() => { mqttWait = null; if (!hostOpened && !stopped) fail(MSG.signal); }, HOST_MQTT_WAIT_MS);
  }

  // Tell the host when no signaling route works at all (and when one is back).
  function hostRoutes() {
    if (!hostOpened || stopped) return;
    const up = peerUp || !!(hostRdv && hostRdv.brokersUp);
    if (!up && !hostSignalNoted) {
      hostSignalNoted = true;
      call('onStatus', 'Lost the online-room server — the game goes on, but new players can\'t join until it is back');
    } else if (up && hostSignalNoted) {
      hostSignalNoted = false;
      call('onStatus', 'Back online — friends can join again');
    }
  }

  // The room is open but not registered with PeerJS: try again later, quietly.
  function retryHostPeer() {
    if (stopped || !hostPopts || peerRetryTimer || !usePeerJS()) return;
    const ms = HOST_RECONNECT_MS[Math.min(hostRetry++, HOST_RECONNECT_MS.length - 1)];
    peerRetryTimer = setTimeout(() => {
      peerRetryTimer = null;
      if (!stopped && !peerUp && (!hostPeer || hostPeer.destroyed)) openHostPeer(code, true, Date.now(), 0, 0);
    }, ms);
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
    // PeerJS reports 'close' only for connections that opened: drop the rest
    setTimeout(() => { if (!conn.open) gone(); }, HALF_OPEN_MS);
    conn.on('error', (err) => {
      // one message that was too big is not a dead connection
      if (err && err.type === 'message-too-big') { try { console.warn('minimaj: message too big'); } catch (e) { /* ignore */ } return; }
      gone();
    });
  }

  // c: the code to register with the PeerJS server; reclaim: c is our earlier
  // code (wait for it rather than take another). since: when we started asking
  // for it; collisions: random codes found taken.
  function openHostPeer(c, reclaim, since, collisions, signalFails) {
    if (stopped) return;
    // a delayed retry after the room opened another way: one Peer at a time
    if (hostOpened && (peerUp || (hostPeer && !hostPeer.destroyed))) return;
    if (!hostOpened) ensureRdv(c);
    let p;
    try { p = new window.Peer(PREFIX + c, hostPopts); } catch (e) { peerGaveUp = true; hostPeer = null; hostFallback(MSG.browser); return; }
    hostPeer = p;
    let registered = false;
    const retire = () => { try { p.destroy(); } catch (e) { /* ignore */ } if (hostPeer === p) hostPeer = null; };
    p.on('open', () => {
      if (hostPeer !== p || stopped) return;
      if (hostOpened && c !== code) { retire(); retryHostPeer(); return; }
      registered = true; peerUp = true; peerRefreshing = false;
      hostRetry = 0; hostRetryAt = 0;
      if (!hostOpened) hostOpen(c);
      hostRoutes();
    });
    p.on('connection', acceptConn);
    p.on('disconnected', () => {
      // lost the room server: running games keep working; tick() reconnects
      if (hostPeer !== p || stopped || !registered) return;
      peerUp = false;
      if (!hostRetryAt) hostRetryAt = Date.now() + HOST_RECONNECT_MS[0];
      if (!peerRefreshing) hostRoutes();
    });
    // A blackholed server (accepts the connection, never answers) sends no
    // event at all: give the registration a time limit.
    setTimeout(() => {
      if (hostPeer !== p || stopped || registered) return;
      if (!hostOpened && !(hostRdv && hostRdv.brokersUp)) { retire(); fail(MSG.signal); return; }
      onErr({ type: 'network' });
    }, HOST_PEER_WAIT_MS);
    p.on('error', onErr);
    function onErr(err) {
      if (hostPeer !== p || stopped) return;
      const type = err && err.type;
      if (type === 'peer-unavailable') return;
      if (registered) {
        // after the room is up: only tell the host when no route is left (hostRoutes)
        if (isSignalErr(err) || type === 'unavailable-id') { peerUp = false; peerRefreshing = false; hostRoutes(); return; }
        call('onStatus', peerErrorText(err, code));
        return;
      }
      retire();
      if (hostOpened) {
        // the room is open over MQTT: keep its code even if somebody else holds
        // it on the PeerJS server (only PeerJS-only clients can't join then)
        if (type === 'unavailable-id' && !codeTakenNoted && Date.now() - hostOpenedAt > RECLAIM_MS) {
          codeTakenNoted = true;
          try { console.warn('minimaj: room code ' + code + ' is held by someone else on the PeerJS server; players reach this room over MQTT only'); } catch (e) { /* ignore */ }
        }
        retryHostPeer();
        return;
      }
      if (type === 'unavailable-id') {
        if (reclaim && Date.now() - since < RECLAIM_MS) {
          // After a reload the server may still hold our old code for a while:
          // keep it, so the link friends already have keeps working.
          if (!code) code = c;
          call('onStatus', `Waiting for room code ${c}…`);
          setTimeout(() => openHostPeer(c, reclaim, since, collisions, signalFails), RECLAIM_EVERY_MS);
        } else if (collisions < 5) {
          if (reclaim) call('onStatus', `Room code ${c} is still in use, so this room gets a new code`);
          openHostPeer(makeCode(), false, Date.now(), collisions + 1, signalFails);
        } else fail('Could not get a room code. Please try again.');
        return;
      }
      // the PeerJS server is unreachable: the MQTT route may open the room meanwhile
      if (tryMqttOpen()) { retryHostPeer(); return; }
      if (isSignalErr(err) && signalFails + 1 < SIGNAL_TRIES) {
        call('onStatus', 'Could not reach the online-room server — retrying…');
        setTimeout(() => {
          if (hostOpened) { if (!hostPeer) retryHostPeer(); return; }
          openHostPeer(c, reclaim, since, collisions, signalFails + 1);
        }, 1500 * (signalFails + 1));
        return;
      }
      peerGaveUp = true;
      hostFallback(peerErrorText(err, c));
    }
  }

  // The host's signaling can die without any event (PeerJS only notices a
  // socket that closes): now and then, after a long hidden spell and when the
  // network changes, register again on a fresh socket, and check the brokers.
  function hostSignalRefresh() {
    if (!hostOpened || stopped) return;
    hostRefreshedAt = Date.now();
    if (hostRdv && hostRdv.refresh) hostRdv.refresh();
    const p = hostPeer;
    if (!p || p.destroyed || p.disconnected || !peerUp || typeof p.disconnect !== 'function') return;
    peerRefreshing = true;
    try { p.disconnect(); } catch (e) { /* ignore */ }
    hostRetryAt = 0;
    hostSignalCheck(true);
  }

  // Keep the host's registration with the PeerJS server alive (backoff), and
  // retry at once when the tab comes back to the front.
  function hostSignalCheck(now) {
    const p = hostPeer;
    if (!p || !hostOpened || stopped || p.destroyed || !p.disconnected) return;
    if (!now && hostRetryAt && Date.now() < hostRetryAt) return;
    hostRetryAt = Date.now() + HOST_RECONNECT_MS[Math.min(hostRetry, HOST_RECONNECT_MS.length - 1)];
    hostRetry++;
    try { p.reconnect(); } catch (e) { /* ignore */ }
  }

  /* ---------- online, joiner: race PeerJS and MQTT to the host ---------- */

  // Each attempt dials over every available route at once. The first data
  // channel that opens becomes the transport and the others are closed; the
  // attempt fails only when every route has failed (or CONNECT_TIMEOUT_MS
  // passed), and the message names the most telling failure: a network that
  // blocks peer-to-peer > a host that does not answer > no such room > no
  // signaling server reachable at all.
  function connectPeer() {
    const bad = codeProblem(code);
    if (bad) { fail(bad); return; }
    if (!hasWebRTC()) { fail(MSG.browser); return; }
    const routes = [];
    let winner = null;
    const t = {
      send(m) { try { if (winner && winner.conn.open) winner.conn.send(m); } catch (e) { /* ignore */ } },
      close() { for (const r of routes) r.close(); },
    };
    transport = t;
    const limit = connectTimeout();
    const deadline = Date.now() + limit;
    const timer = setTimeout(() => {
      if (transport !== t || winner) return;
      for (const r of routes) if (!r.failed) { r.failed = { kind: r.diag() }; r.close(); }
      settle();
    }, limit);

    function settle() {
      if (transport !== t || winner || routes.some((r) => !r.failed)) return;
      clearTimeout(timer);
      const kinds = routes.map((r) => r.failed.kind);
      const other = routes.find((r) => r.failed.kind === 'other');
      if (kinds.includes('browser')) fail(MSG.browser);
      else if (kinds.includes('ice')) onDrop(t, 'Could not connect to the host', MSG.ice);
      else if (kinds.includes('noAnswer')) onDrop(t, 'Could not reach the host', MSG.noAnswer);
      else if (kinds.includes('notFound')) {
        if (!everOpen) { call('onError', MSG.notFound(code), true, { notFound: code }); stop(); } else onDrop(t, 'The host is away', MSG.notFound(code));
      } else if (other) onDrop(t, other.failed.text, other.failed.text);
      else onDrop(t, 'Could not reach the online-room server', MSG.signal);
    }

    // kind: 'signal' | 'notFound' | 'noAnswer' | 'ice' | 'browser' | 'other' (with text)
    const route = (diag) => {
      const r = { conn: null, failed: null, diag };
      r.close = () => { try { if (r.conn) r.conn.close(); } catch (e) { /* ignore */ } };
      r.lose = (kind, text) => {
        if (r.failed || winner || transport !== t) return;
        r.failed = { kind, text };
        r.close();
        // A definite answer (no such room, ICE failed) settles it for routes
        // that have not even reached their server yet: a blackholed PeerJS
        // server must not hold every attempt open until the timeout.
        if (kind === 'notFound' || kind === 'ice') {
          for (const x of routes) if (!x.failed && x.diag() === 'signal') { x.failed = { kind: 'signal' }; x.close(); }
        }
        settle();
      };
      r.wire = (c) => {
        r.conn = c;
        c.on('open', () => win(r));
      };
      routes.push(r);
      return r;
    };

    function win(r) {
      if (winner || transport !== t || r.failed || stopped) { if (winner !== r) r.close(); return; }
      winner = r;
      clearTimeout(timer);
      for (const x of routes) if (x !== r) x.close();
      const c = r.conn;
      c.on('data', (d) => onMessage(t, d));
      c.on('close', () => onDrop(t, 'Connection lost'));
      c.on('error', (err) => { if (!(err && err.type === 'message-too-big')) onDrop(t, 'Connection lost'); });
      onOpen(t);
    }

    if (usePeerJS()) dialPeerJS(route, t);
    const rt = mqttRoute();
    if (rt) {
      const r = route(() => 'noAnswer');
      iceServers().then((servers) => {
        if (transport !== t || r.failed || winner) return;
        const c = dialRendezvous({ code, ...rt, iceServers: servers, timeoutMs: Math.max(2000, deadline - Date.now() - 500) });
        r.wire(c);
        c.on('error', (err) => {
          const type = err && err.type;
          r.lose(type === 'signal' ? 'signal' : type === 'peer-unavailable' ? 'notFound' : type === 'browser-incompatible' ? 'browser' : 'ice');
        });
        c.on('close', () => { if (winner !== r) r.lose('ice'); });
      });
    }
    if (!routes.length) settle();
  }

  // The PeerJS route of one attempt, with its own Peer (our registration with
  // the PeerJS server). The Peer stays while its connection is in use; its
  // errors go to the current attempt's route.
  let peerAttempt = null;
  function dialPeerJS(route, t) {
    let stage = 'load'; // load -> signal (waiting for the room server) -> dial (waiting for the host)
    let ice = 'new';
    const r = route(() => {
      if (stage !== 'dial') return 'signal';
      const st = (r.conn && r.conn.peerConnection && r.conn.peerConnection.iceConnectionState) || ice;
      return st === 'new' ? 'noAnswer' : 'ice';
    });
    peerAttempt = r;
    const dial = () => {
      if (transport !== t || r.failed) return;
      stage = 'dial';
      let c = null;
      try { c = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' }); } catch (e) { c = null; }
      if (!c) { r.lose(r.diag()); return; }
      r.wire(c);
      c.on('iceStateChanged', (s) => { ice = s; });
      c.on('close', () => r.lose(r.diag()));
      c.on('error', (err) => {
        if (err && err.type === 'message-too-big') return;
        if (err && err.type === 'negotiation-failed') ice = 'failed';
        r.lose(r.diag());
      });
    };
    Promise.all([loadPeerJS(), peerOptions()]).then(([, popts]) => {
      if (transport !== t || r.failed) return;
      stage = 'signal';
      // Always a fresh Peer: PeerJS never notices a signaling socket that died
      // silently (VPN reconnect, cell handover), and every dial through it
      // would time out, forever.
      if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } peer = null; }
      let p;
      try { p = new window.Peer(popts); } catch (e) { r.lose('browser'); return; }
      peer = p;
      p.on('open', () => { if (peer === p) dial(); });
      p.on('error', (err) => {
        if (peer !== p || stopped || !peerAttempt) return;
        const type = err && err.type;
        // Losing the room server does not break an open data channel (lose()
        // ignores routes once a winner is chosen); a new Peer is made if we
        // ever need to reconnect.
        if (type === 'browser-incompatible') peerAttempt.lose('browser');
        else if (type === 'peer-unavailable') peerAttempt.lose('notFound');
        else if (isSignalErr(err)) peerAttempt.lose('signal');
        else peerAttempt.lose('other', peerErrorText(err, code));
      });
      p.on('disconnected', () => { /* data channels survive; see above */ });
    }, (e) => r.lose('other', e.message));
  }

  /* ---------- lifecycle ---------- */

  function stop() {
    if (stopped) return;
    stopped = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
    try { document.removeEventListener('visibilitychange', onVisible); } catch (e) { /* ignore */ }
    listenNet(false);
    const t = transport;
    transport = null;
    if (t) { try { t.close(); } catch (e) { /* ignore */ } }
    if (room) { try { room.destroy(); } catch (e) { /* ignore */ } room = null; }
    // tell the guests at once (a closed tab would too), rather than after their timeout
    if (hostConns) { for (const c of hostConns.values()) { try { c.close(); } catch (e) { /* ignore */ } } hostConns.clear(); }
    if (hostPeer) { try { hostPeer.destroy(); } catch (e) { /* ignore */ } hostPeer = null; }
    if (hostRdv) { hostRdv.close(); hostRdv = null; }
    if (peerRetryTimer) { clearTimeout(peerRetryTimer); peerRetryTimer = null; }
    if (mqttWait) { clearTimeout(mqttWait); mqttWait = null; }
    if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } peer = null; }
    setConn('closed');
  }

  try { document.addEventListener('visibilitychange', onVisible); } catch (e) { /* ignore */ }
  listenNet(true);
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
    playAgain() { send({ t: 'lobby-cmd', cmd: 'again' }); },
    reroll() { send({ t: 'lobby-cmd', cmd: 'reroll' }); }, // a new random mascot (lobby only)
    // a mascot emote for everyone; false (nothing sent) when unknown, offline or too soon
    emote(kind) {
      if (EMOTES.indexOf(kind) < 0 || !transport || connState !== 'open') return false;
      if (!emoteAllowed(emoteTimes, Date.now(), 400)) return false;
      send({ t: 'emote', e: kind });
      return true;
    },
    // let the computer play a disconnected friend's seat (a majority of you decides)
    voteCpu(seat) { send({ t: 'vote-cpu', seat }); },
    // you touched the screen while your mascot sleeps
    wake() { send({ t: 'wake' }); },
    // reconnect at once instead of waiting for the next try; false when not reconnecting
    retryNow() { return retryNow(); },
    close() { stop(); },
  };
}
