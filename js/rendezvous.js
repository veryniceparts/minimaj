// Signaling over public MQTT brokers: a second way (next to PeerJS) for an
// online room's players to find each other. Only the WebRTC offer and answer
// travel through the brokers; game data then flows over a direct WebRTC data
// channel (or the TURN relay), exactly as with PeerJS.
//
// Every message goes to all configured brokers at once, so the room works as
// long as both players reach at least one of them; duplicates are dropped by
// message id. Topics and payloads are derived from the room code: the topic is
// a hash of it, and payloads are AES-GCM encrypted with a key hashed from it,
// so brokers and other rooms see only noise, and anything that does not
// decrypt is ignored.
//
//   guest -> base/host     { t: 'probe', g }         is anybody hosting?
//   host  -> base/g/<g>    { t: 'here' }              yes
//   guest -> base/host     { t: 'offer', g, o, sdp }  (re-sent until answered)
//   host  -> base/g/<g>    { t: 'answer', o, sdp }
//   both                   { t: 'cand', o, c }        late ICE candidates
//   host  -> base/alive    { t: 'alive' }             every 10 s
//
// The connection object mimics a PeerJS DataConnection, so js/net.js treats
// both routes alike: { open, peerConnection, send(obj), close(), on(event, fn) }
// with events 'open', 'data' (parsed object), 'close' and 'error'
// ({ type: 'signal' | 'peer-unavailable' | 'negotiation-failed' | 'browser-incompatible' }).
import { mqttConnect } from './mqtt.js';

const MAX_AGE_MS = 60000; // older messages are replays or from a badly set clock
const GATHER_MS = 2500; // wait this long for ICE candidates before sending a description
const RESEND_MS = 3000; // guest: send the offer again until answered
const ALIVE_MS = 10000;
const DIAL_TIMEOUT_MS = 12000;
const NOT_FOUND_MS = 6000; // guest: brokers up this long without a sign of the host = no such room
const SIGNAL_WAIT_MS = 8000; // guest: no broker reachable this long = signaling blocked
const MAX_PENDING = 8; // host: half-open offers at a time
const HALF_OPEN_MS = 30000; // host: an offer whose channel is not open by then is dropped

/* ---------- small helpers ---------- */

const subtle = () => (globalThis.crypto && globalThis.crypto.subtle) || null;
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const randHex = (n) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return hex(b); };
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

class Emitter {
  constructor() { this._h = {}; }
  on(e, f) { (this._h[e] = this._h[e] || []).push(f); return this; }
  off(e, f) { const a = this._h[e]; if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } return this; }
  emit(e, ...a) { for (const f of (this._h[e] || []).slice()) { try { f(...a); } catch (err) { console.error('rendezvous ' + e, err); } } }
}

/* ---------- room topic and key ---------- */

const keyCache = new Map();
// { base: 'minimaj/v1/<24 hex>', key: CryptoKey } for a room code
export function roomKeys(code) {
  if (!keyCache.has(code)) {
    const s = subtle();
    const p = (async () => {
      const t = new Uint8Array(await s.digest('SHA-256', enc.encode('minimaj-topic:' + code)));
      const k = await s.digest('SHA-256', enc.encode('minimaj-key:' + code));
      const key = await s.importKey('raw', k, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      return { base: 'minimaj/v1/' + hex(t).slice(0, 24), key };
    })();
    p.catch(() => keyCache.delete(code));
    keyCache.set(code, p);
  }
  return keyCache.get(code);
}

// base64(iv | AES-GCM(JSON))
export async function seal(key, obj) {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return b64(out);
}

// the object, or null for anything that is not ours (wrong key, tampered, junk)
export async function unseal(key, text) {
  try {
    const raw = unb64(String(text));
    if (raw.length < 29) return null;
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, key, raw.subarray(12));
    const m = JSON.parse(dec.decode(pt));
    return m && typeof m === 'object' && typeof m.t === 'string' ? m : null;
  } catch (e) {
    return null;
  }
}

/* ---------- the bus: one room's topics on every broker ---------- */

// opts: { code, brokers, WebSocket, onStatus(upCount) }
async function createBus(opts) {
  const { base, key } = await roomKeys(opts.code);
  const seen = new Map(); // message id -> time
  let closed = false;
  const clients = opts.brokers.map((url) => mqttConnect(url, {
    WebSocket: opts.WebSocket,
    onStatus: () => { if (!closed && opts.onStatus) opts.onStatus(bus.up); },
  }));
  const bus = {
    base,
    get up() { return clients.filter((c) => c.connected).length; },
    subscribe(sub, fn) {
      for (const c of clients) {
        c.subscribe(base + sub, async (payload) => {
          const m = await unseal(key, payload);
          if (!m || closed || typeof m.id !== 'string') return;
          const now = Date.now();
          if (!(Math.abs(now - m.ts) <= MAX_AGE_MS) || seen.has(m.id)) return;
          seen.set(m.id, now);
          if (seen.size > 500) for (const [id, at] of seen) if (now - at > 2 * MAX_AGE_MS) seen.delete(id);
          fn(m);
        });
      }
    },
    // to every connected broker; resolves to how many took it
    async send(sub, obj) {
      if (closed) return 0;
      const text = await seal(key, { ...obj, id: randHex(8), ts: Date.now() });
      let n = 0;
      for (const c of clients) if (c.publish(base + sub, text)) n++;
      return n;
    },
    refresh() { for (const c of clients) c.refresh(); },
    close() { closed = true; for (const c of clients) c.close(); },
  };
  return bus;
}

/* ---------- WebRTC helpers ---------- */

// Resolves once ICE gathering is complete or after GATHER_MS, whichever is first.
function gathered(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const timer = setTimeout(done, GATHER_MS);
    const prev = pc.onicegatheringstatechange;
    function done() {
      clearTimeout(timer);
      pc.onicegatheringstatechange = prev;
      resolve();
    }
    pc.onicegatheringstatechange = (e) => {
      if (prev) prev.call(pc, e);
      if (pc.iceGatheringState === 'complete') done();
    };
  });
}

const descOf = (pc) => { const d = pc.localDescription; return d ? { type: d.type, sdp: d.sdp } : null; };

// A PeerJS-like connection around one RTCPeerConnection and its data channel.
function makeConn(pc, onGone) {
  const conn = new Emitter();
  let dc = null;
  let ended = false;
  conn.open = false;
  conn.peerConnection = pc;
  conn.send = (obj) => {
    if (!dc || dc.readyState !== 'open') return;
    try { dc.send(JSON.stringify(obj)); } catch (e) { /* ignore: the channel is closing */ }
  };
  conn.close = () => end(false);
  function end(failed) {
    if (ended) return;
    ended = true;
    const was = conn.open;
    conn.open = false;
    try { if (dc) dc.close(); } catch (e) { /* ignore */ }
    try { pc.close(); } catch (e) { /* ignore */ }
    if (onGone) onGone();
    if (was) conn.emit('close');
    else if (failed) conn.emit('error', { type: 'negotiation-failed' });
  }
  conn._fail = () => end(true);
  conn._ended = () => ended;
  conn._attach = (channel) => {
    dc = channel;
    const opened = () => {
      if (ended || conn.open) return;
      conn.open = true;
      conn.emit('open');
    };
    dc.onopen = opened;
    dc.onclose = () => end(false);
    dc.onerror = () => {};
    dc.onmessage = (e) => {
      if (!conn.open || typeof e.data !== 'string') return;
      let d;
      try { d = JSON.parse(e.data); } catch (err) { return; }
      conn.emit('data', d);
    };
    if (dc.readyState === 'open') opened();
  };
  // ICE failed: before the channel opened that is a negotiation failure; after
  // it, a closed connection. 'disconnected' may recover, so it is left alone.
  const check = () => {
    const s = pc.connectionState, i = pc.iceConnectionState;
    if (s === 'failed' || i === 'failed' || s === 'closed') end(true);
  };
  pc.onconnectionstatechange = check;
  pc.oniceconnectionstatechange = check;
  return conn;
}

const usable = (o) => !!(o.brokers && o.brokers.length && (o.WebSocket || globalThis.WebSocket) && o.RTCPeerConnection && subtle());

/* ---------- host ---------- */

// opts: { code, iceServers (a list, or an async function returning one), brokers,
//         WebSocket?, RTCPeerConnection?, onConnection(conn), onStatus(brokersUp) }
// Returns { code, close(), refresh(), brokersUp, active } — set active = true once the
// room is ready for players; until then probes and offers are ignored.
export function hostRendezvous(opts) {
  const RTC = opts.RTCPeerConnection || globalThis.RTCPeerConnection;
  const o = { ...opts, RTCPeerConnection: RTC };
  const sessions = new Map(); // g + ':' + offer id -> { pc, conn, answer, at }
  let bus = null;
  let closed = false;
  let aliveTimer = null;
  const h = {
    code: opts.code,
    active: false,
    get brokersUp() { return bus ? bus.up : 0; },
    // check every broker link now (see mqtt.js refresh)
    refresh() { if (bus && !closed) bus.refresh(); },
    close() {
      if (closed) return;
      closed = true;
      if (aliveTimer) { clearTimeout(aliveTimer); aliveTimer = null; }
      if (bus) bus.close();
      for (const s of sessions.values()) if (!s.conn.open) s.conn.close();
      sessions.clear();
    },
  };
  if (!usable(o)) return h;

  const alive = () => {
    aliveTimer = setTimeout(alive, ALIVE_MS);
    if (h.active) bus.send('/alive', { t: 'alive' });
    // forget offers that never connected
    const now = Date.now();
    for (const [k, s] of sessions) {
      if (now - s.at > 2 * MAX_AGE_MS || (!s.conn.open && (s.conn._ended() || now - s.at > HALF_OPEN_MS))) {
        if (!s.conn.open) s.conn.close();
        sessions.delete(k);
      }
    }
  };

  async function onOffer(m) {
    if (typeof m.g !== 'string' || typeof m.o !== 'string' || !m.sdp || m.sdp.type !== 'offer' || typeof m.sdp.sdp !== 'string') return;
    const k = m.g + ':' + m.o;
    const old = sessions.get(k);
    if (old) {
      // the guest did not get our answer yet (or a broker was late): repeat it
      if (old.answer) bus.send('/g/' + m.g, { t: 'answer', o: m.o, sdp: old.answer });
      return;
    }
    let pending = 0;
    for (const s of sessions.values()) if (!s.conn.open && !s.conn._ended()) pending++;
    if (pending >= MAX_PENDING) return;
    let servers = opts.iceServers || [];
    if (typeof servers === 'function') { try { servers = await servers(); } catch (e) { servers = []; } }
    if (closed || sessions.has(k)) return;
    let pc;
    try { pc = new RTC({ iceServers: servers }); } catch (e) { return; }
    const conn = makeConn(pc, null);
    const s = { pc, conn, answer: null, at: Date.now(), g: m.g };
    sessions.set(k, s);
    pc.ondatachannel = (e) => {
      if (closed || conn._ended()) return;
      try { opts.onConnection(conn); } catch (err) { console.error('rendezvous onConnection', err); }
      conn._attach(e.channel);
    };
    let sent = false;
    pc.onicecandidate = (e) => {
      // candidates found after the answer went out ("trickle"); null = done
      if (sent && e.candidate && !closed) bus.send('/g/' + m.g, { t: 'cand', o: m.o, c: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
    };
    try {
      await pc.setRemoteDescription(m.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
    } catch (e) {
      conn._fail();
      return;
    }
    if (closed || conn._ended()) return;
    s.answer = descOf(pc);
    sent = true;
    bus.send('/g/' + m.g, { t: 'answer', o: m.o, sdp: s.answer });
  }

  (async () => {
    try {
      bus = await createBus({ ...o, onStatus: (n) => { if (opts.onStatus) opts.onStatus(n); } });
    } catch (e) {
      return; // no WebCrypto: this route is simply unavailable
    }
    if (closed) { bus.close(); return; }
    bus.subscribe('/host', (m) => {
      if (closed || !h.active) return;
      if (m.t === 'probe' && typeof m.g === 'string') bus.send('/g/' + m.g, { t: 'here' });
      else if (m.t === 'offer') onOffer(m);
      else if (m.t === 'cand' && typeof m.g === 'string' && typeof m.o === 'string' && m.c) {
        const s = sessions.get(m.g + ':' + m.o);
        if (s && s.pc.remoteDescription) s.pc.addIceCandidate(m.c).catch(() => {});
      }
    });
    alive();
  })();
  return h;
}

/* ---------- guest ---------- */

// opts: { code, iceServers, brokers, timeoutMs?, notFoundMs?, WebSocket?,
//         RTCPeerConnection?, onStatus(text) }
// Returns a connection object at once; it emits 'open' or 'error'.
export function dialRendezvous(opts) {
  const RTC = opts.RTCPeerConnection || globalThis.RTCPeerConnection;
  const o = { ...opts, RTCPeerConnection: RTC };
  const timeoutMs = opts.timeoutMs || DIAL_TIMEOUT_MS;
  const notFoundMs = opts.notFoundMs || NOT_FOUND_MS;
  let bus = null;
  let pc = null;
  let conn = null;
  let done = false; // opened, failed or closed by the caller
  let hostSeen = false;
  let brokerSeen = false;
  let answered = false;
  let offer = null;
  const timers = [];
  const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };
  const g = usable(o) ? randHex(8) : '';
  const oid = g ? randHex(4) : '';
  const queued = []; // host candidates that came before the answer

  // stand-in until the RTCPeerConnection exists (WebCrypto is async)
  const front = new Emitter();
  front.open = false;
  front.peerConnection = null;
  front.send = (obj) => { if (conn) conn.send(obj); };
  front.close = () => {
    if (done && !front.open) return;
    finish();
    if (conn) conn.close(); else if (pc) { try { pc.close(); } catch (e) { /* ignore */ } }
  };

  function finish() {
    done = true;
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
    if (bus) { bus.close(); bus = null; }
  }
  function fail(type) {
    if (done) return;
    finish();
    if (conn) conn.close(); else if (pc) { try { pc.close(); } catch (e) { /* ignore */ } }
    front.emit('error', { type });
  }
  const status = (text) => { if (opts.onStatus) { try { opts.onStatus(text); } catch (e) { /* ignore */ } } };

  if (!g) {
    setTimeout(() => fail(RTC ? 'signal' : 'browser-incompatible'), 0);
    return front;
  }

  later(() => fail(!brokerSeen ? 'signal' : hostSeen ? 'negotiation-failed' : 'peer-unavailable'), timeoutMs);
  later(() => { if (!brokerSeen) fail('signal'); }, Math.min(SIGNAL_WAIT_MS, timeoutMs));

  const sendOffer = () => {
    if (done || answered || !bus || !bus.up) return;
    bus.send('/host', { t: 'probe', g });
    if (offer) bus.send('/host', { t: 'offer', g, o: oid, sdp: offer });
  };
  const resend = () => { if (done || answered) return; sendOffer(); later(resend, RESEND_MS); };

  const onBrokers = (n) => {
    if (done || !n) return;
    if (!brokerSeen) {
      brokerSeen = true;
      status('Looking for the host…');
      later(() => { if (!hostSeen && !answered) fail('peer-unavailable'); }, notFoundMs);
      resend();
    } else sendOffer(); // another broker came up: the host may only be on that one
  };

  async function onAnswer(m) {
    if (answered || m.o !== oid || !m.sdp || m.sdp.type !== 'answer' || typeof m.sdp.sdp !== 'string') return;
    answered = true;
    hostSeen = true;
    try {
      await pc.setRemoteDescription(m.sdp);
      for (const c of queued.splice(0)) pc.addIceCandidate(c).catch(() => {});
    } catch (e) {
      fail('negotiation-failed');
    }
  }

  (async () => {
    try {
      bus = await createBus({ ...o, onStatus: onBrokers });
    } catch (e) {
      fail('signal');
      return;
    }
    if (done) { bus.close(); bus = null; return; }
    bus.subscribe('/alive', () => { hostSeen = true; });
    bus.subscribe('/g/' + g, (m) => {
      if (done) return;
      if (m.t === 'here') hostSeen = true;
      else if (m.t === 'answer') onAnswer(m);
      else if (m.t === 'cand' && m.o === oid && m.c) {
        if (pc.remoteDescription) pc.addIceCandidate(m.c).catch(() => {});
        else queued.push(m.c);
      }
    });
    try {
      pc = new RTC({ iceServers: opts.iceServers || [] });
    } catch (e) {
      fail('browser-incompatible');
      return;
    }
    front.peerConnection = pc;
    conn = makeConn(pc, null);
    conn.on('open', () => {
      if (done) { conn.close(); return; }
      finish(); // signaling is no longer needed
      front.open = true;
      front.emit('open');
    });
    conn.on('data', (d) => front.emit('data', d));
    conn.on('close', () => { front.open = false; front.emit('close'); });
    conn.on('error', (e) => fail(e.type));
    let sent = false;
    pc.onicecandidate = (e) => {
      if (sent && e.candidate && bus && !done) bus.send('/host', { t: 'cand', g, o: oid, c: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
    };
    try {
      conn._attach(pc.createDataChannel('minimaj', { ordered: true }));
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
    } catch (e) {
      fail('negotiation-failed');
      return;
    }
    if (done) return;
    offer = descOf(pc);
    sent = true;
    sendOffer();
  })();
  return front;
}
