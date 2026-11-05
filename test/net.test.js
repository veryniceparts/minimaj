// Tests for js/net.js (LAN mode) in Node: fake browser globals, a fake
// WebSocket bridged to a real room, and the manual clock.
import assert from 'node:assert/strict';
import { installFakeClock } from './fakeclock.js';
import { createRoom } from '../js/room.js';

export async function runNetTests() {
  const { createSession, normCode } = await import('../js/net.js');
  const clock = installFakeClock();
  const realNow = Date.now;
  Date.now = clock.now;
  const saved = {};
  for (const k of ['window', 'document', 'location', 'WebSocket']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const store = new Map();
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const listeners = [];
  const document = {
    visibilityState: 'visible',
    addEventListener: (e, f) => listeners.push(f),
    removeEventListener: (e, f) => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
  };
  const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  def('window', { localStorage, sessionStorage: localStorage });
  def('document', document);
  def('location', { protocol: 'http:', host: 'localhost:7777', origin: 'http://localhost:7777', pathname: '/' });

  // fake server: one room, sockets bridged with a tick of latency
  let nextId = 1;
  const sockets = new Map();
  let nextHostOk = false;
  let blackhole = null; // socket id whose traffic is dropped
  const room = createRoom({
    send: (id, m) => { const ws = sockets.get(id); if (ws && id !== blackhole) { const data = JSON.stringify(m); setTimeout(() => ws.readyState === 1 && ws.onmessage && ws.onmessage({ data }), 1); } },
    close: (id) => { const ws = sockets.get(id); if (ws) ws._serverClose(); },
    now: clock.now,
    botDelay: 100000,
  });
  class FakeWS {
    constructor(url) {
      assert.equal(url, 'ws://localhost:7777/ws');
      this.id = nextId++; this.readyState = 0;
      sockets.set(this.id, this);
      const hostOk = nextHostOk;
      setTimeout(() => { if (this.readyState !== 0) return; this.readyState = 1; room.open(this.id, { hostOk }); if (this.onopen) this.onopen(); }, 1);
    }
    send(text) { assert.equal(this.readyState, 1); if (this.id === blackhole) return; const m = JSON.parse(text); setTimeout(() => room.message(this.id, m), 1); }
    close() { this._serverClose(); }
    _serverClose() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      sockets.delete(this.id);
      setTimeout(() => { room.closed(this.id); if (this.onclose) this.onclose({}); }, 1);
    }
  }
  def('WebSocket', FakeWS);

  const mkClient = (name, cid, hostOk) => {
    store.set('minimaj-cid', cid);
    const log = { lobby: null, view: null, errors: [], conn: [], status: [], emotes: [] };
    nextHostOk = hostOk;
    const info = { server: true, hostOk, lanUrls: ['http://192.168.1.5:7777'] };
    const s = createSession({ mode: 'lan', name, info }, {
      onLobby: (l) => { log.lobby = l; },
      onView: (v) => { log.view = v; },
      onError: (msg, fatal) => log.errors.push([msg, fatal]),
      onConn: (st) => log.conn.push(st),
      onStatus: (t) => log.status.push(t),
      onEmote: (e) => log.emotes.push(e),
    });
    return { s, log };
  };

  let n = 0;
  assert.equal(normCode(' ab-c d9xyz '), 'ABCD9');
  n++;

  const A = mkClient('Alice', 'cid-a', true);
  clock.advance(50);
  assert.deepEqual(A.log.conn, ['connecting', 'open']);
  assert.equal(A.s.isHost, true);
  assert.equal(A.s.cid, 'cid-a');
  assert.equal(A.log.lobby.mode, 'lan');
  assert.equal(A.log.lobby.joinUrl, 'http://192.168.1.5:7777');
  assert.deepEqual(A.log.lobby.lanUrls, ['http://192.168.1.5:7777']);
  assert.equal(A.log.lobby.code, null);
  const B = mkClient('Bob', 'cid-b', false);
  clock.advance(50);
  assert.equal(B.s.isHost, false);
  assert.equal(A.log.lobby.members.length, 2);
  n++;

  // non-host commands are refused, host commands work
  B.s.start();
  clock.advance(50);
  assert.deepEqual(B.log.errors.at(-1), ['Only the host can do that.', false]);
  A.s.setSettings({ length: 2 });
  clock.advance(50);
  assert.equal(B.log.lobby.settings.length, 2);
  A.s.start();
  clock.advance(50);
  assert.ok(A.log.view && B.log.view);
  assert.equal(A.log.view.isHost, true);
  assert.equal(B.log.view.isHost, false);
  const seatB = B.log.view.seat;
  n++;

  // emotes: sent through the room to everyone with the sender's seat; the client
  // applies the room's rate limit itself (false = not sent); junk kinds are refused
  assert.equal(B.s.emote('hurray'), true);
  assert.equal(B.s.emote('sad'), false); // too soon
  assert.equal(B.s.emote('dance'), false);
  clock.advance(50);
  assert.deepEqual(A.log.emotes.map(({ seat, e }) => [seat, e]), [[seatB, 'hurray']]);
  assert.deepEqual(B.log.emotes.map(({ seat, e }) => [seat, e]), [[seatB, 'hurray']]);
  assert.ok(A.log.emotes[0].n > 0 && !('member' in A.log.emotes[0]));
  clock.advance(1700);
  assert.equal(B.s.emote('think-left'), true);
  clock.advance(50);
  assert.deepEqual(A.log.emotes.at(-1).e, 'think-left');
  assert.ok(A.log.emotes.at(-1).n > A.log.emotes[0].n);
  n++;

  // pings keep both alive for a long time
  clock.advance(30000);
  assert.deepEqual(B.log.conn, ['connecting', 'open']);
  assert.equal(A.log.view.players[seatB].kind, 'human');

  // B's link goes silent: B notices within ~9-10 s, reconnects with the same cid and gets its seat back
  blackhole = [...sockets.values()].find((w) => w.id !== 1 && w.readyState === 1).id;
  clock.advance(11000);
  assert.ok(B.log.conn.includes('reconnecting'));
  assert.equal(B.log.conn.at(-1), 'open');
  assert.equal(B.log.view.seat, seatB);
  assert.equal(B.log.view.players[seatB].kind, 'human');
  blackhole = null;
  n++;

  // hidden tab: when a retry is pending, becoming visible reconnects at once
  const wsB = [...sockets.values()].find((w) => w.id !== 1 && w.readyState === 1);
  wsB._serverClose();
  clock.advance(5); // close seen, retry scheduled in 500 ms (backoff restarted after the last success)
  assert.equal(B.log.conn.at(-1), 'reconnecting');
  for (const f of listeners.slice()) f();
  clock.advance(20);
  assert.equal(B.log.conn.at(-1), 'open');
  n++;

  // the server goes away: backoff grows 0.5, 1, 2, 4, 8, 8 s ...
  let refuse = true;
  const RealWS = globalThis.WebSocket;
  const opened = [];
  def('WebSocket', class extends RealWS {
    constructor(url) {
      super(url);
      opened.push(clock.now());
      if (refuse) { this.readyState = 3; sockets.delete(this.id); setTimeout(() => this.onclose && this.onclose({}), 1); }
    }
  });
  const wsB2 = [...sockets.values()].find((w) => w.id !== 1 && w.readyState === 1);
  const t0 = clock.now();
  wsB2._serverClose();
  clock.advance(40000);
  const gaps = opened.map((t, i) => t - (i ? opened[i - 1] : t0));
  assert.deepEqual(gaps.slice(0, 6).map((g) => Math.round(g / 100) * 100), [500, 1000, 2000, 4000, 8000, 8000]);
  refuse = false;
  clock.advance(9000);
  assert.equal(B.log.conn.at(-1), 'open');
  assert.equal(B.log.view.seat, seatB);
  n++;

  // fatal error: no more reconnects
  const before = opened.length;
  const errs = B.log.errors.length;
  const wsB3 = [...sockets.values()].find((w) => w.id !== 1 && w.readyState === 1);
  room.message(wsB3.id, { t: 'hello', ver: 999 });
  clock.advance(30000);
  assert.deepEqual(B.log.errors[errs][1], true);
  assert.equal(B.log.conn.at(-1), 'closed');
  assert.equal(opened.length, before);
  n++;

  // back to lobby, then close
  A.s.backToLobby();
  clock.advance(50);
  assert.ok(A.log.lobby.isHost);
  A.s.close();
  clock.advance(50);
  assert.equal(A.log.conn.at(-1), 'closed');
  room.destroy();
  n++;

  clock.runAll(() => false, 1000);
  clock.uninstall();
  Date.now = realNow;
  for (const k of Object.keys(saved)) {
    if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k];
  }
  n += await runOnlineTests();
  return n;
}

/* ---------------- online rooms (PeerJS) with a fake PeerJS ---------------- */

const tickReal = () => new Promise((r) => setImmediate(r)); // lets real promises (PeerJS load, ICE config) settle

async function runOnlineTests() {
  const net = await import('../js/net.js');
  const { createSession, codeProblem, parseIceResponse, hasTurn, iceServers } = net;
  let n = 0;

  // pure helpers
  assert.equal(codeProblem('ABCDE'), null);
  assert.ok(/5-character/.test(codeProblem('ABC')));
  assert.ok(/never contain/.test(codeProblem('ABCD0')));
  assert.deepEqual(parseIceResponse([{ urls: 'turn:a' }, { nope: 1 }, null]), [{ urls: 'turn:a' }]);
  assert.deepEqual(parseIceResponse({ iceServers: { urls: ['turn:b'], username: 'u', credential: 'c' } }), [{ urls: ['turn:b'], username: 'u', credential: 'c' }]);
  assert.deepEqual(parseIceResponse({ iceServers: [{ urls: 'stun:c' }] }), [{ urls: 'stun:c' }]);
  assert.deepEqual(parseIceResponse('junk'), []);
  assert.equal(hasTurn([{ urls: 'stun:x' }]), false);
  assert.equal(hasTurn([{ urls: ['stun:x', 'turns:y:443'] }]), true);
  n++;

  const clock = installFakeClock();
  const realNow = Date.now;
  Date.now = clock.now;
  const saved = {};
  for (const k of ['window', 'document', 'location', 'fetch']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  const mkStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
  const listeners = [];
  def('document', {
    visibilityState: 'visible',
    addEventListener: (e, f) => listeners.push(f),
    removeEventListener: (e, f) => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
  });
  def('location', { protocol: 'https:', host: 'example.org', origin: 'https://example.org', pathname: '/minimaj/' });

  // fake PeerJS: a signaling registry plus data connections with 1 ms latency
  const net0 = { ids: new Map(), up: true, iceBlocked: false, taken: new Map(), opts: [] };
  class Em {
    constructor() { this.h = {}; }
    on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; }
    emit(e, ...a) { for (const f of (this.h[e] || []).slice()) f(...a); }
  }
  class Conn extends Em {
    constructor(peerId) { super(); this.peer = peerId; this.open = false; this.other = null; this.peerConnection = { iceConnectionState: 'new' }; }
    send(d) { const o = this.other; const copy = JSON.parse(JSON.stringify(d)); setTimeout(() => { if (o && o.open) o.emit('data', copy); }, 1); }
    close() { if (!this.open && !this.other) return; const o = this.other; this.other = null; const was = this.open; this.open = false; if (was) this.emit('close'); if (o) o.close(); }
  }
  let anon = 0;
  class FakePeer extends Em {
    constructor(id, opts) {
      super();
      if (id && typeof id === 'object') { opts = id; id = null; }
      net0.opts.push(opts);
      this.id = id || 'anon' + ++anon; this.open = false; this.disconnected = false; this.destroyed = false;
      setTimeout(() => this._register(), 5);
    }
    _register() {
      if (this.destroyed) return;
      if (!net0.up) { this.emit('error', { type: 'network' }); this.disconnected = true; this.emit('disconnected'); return; }
      const until = net0.taken.get(this.id);
      if ((until && clock.now() < until) || (net0.ids.has(this.id) && net0.ids.get(this.id) !== this)) { this.emit('error', { type: 'unavailable-id' }); this.disconnected = true; this.emit('disconnected'); return; }
      net0.ids.set(this.id, this); this.open = true; this.disconnected = false; this.emit('open', this.id);
    }
    _drop() { if (net0.ids.get(this.id) === this) net0.ids.delete(this.id); this.open = false; this.emit('error', { type: 'network' }); this.disconnected = true; this.emit('disconnected'); }
    reconnect() { if (!this.disconnected || this.destroyed) throw new Error('bad reconnect'); this.disconnected = false; setTimeout(() => this._register(), 5); }
    connect(id) {
      const c = new Conn(id);
      setTimeout(() => {
        const host = net0.ids.get(id);
        if (!host || !net0.up) { this.emit('error', { type: 'peer-unavailable' }); return; }
        if (net0.iceBlocked) { c.peerConnection.iceConnectionState = 'checking'; c.emit('iceStateChanged', 'checking'); return; }
        const hc = new Conn(this.id);
        c.other = hc; hc.other = c;
        host.emit('connection', hc);
        setTimeout(() => { hc.open = true; c.open = true; hc.emit('open'); c.emit('open'); }, 2);
      }, 3);
      return c;
    }
    destroy() { this.destroyed = true; this.open = false; if (net0.ids.get(this.id) === this) net0.ids.delete(this.id); }
  }
  const mkWindow = (extra = {}) => ({ localStorage: mkStore(), sessionStorage: mkStore(), Peer: FakePeer, RTCPeerConnection: function () {}, ...extra });

  const mk = (opts, win) => {
    def('window', win || mkWindow());
    const log = { lobby: null, view: null, errors: [], conn: [], status: [], emotes: [] };
    const s = createSession(opts, {
      onLobby: (l) => { log.lobby = l; },
      onView: (v) => { log.view = v; },
      onError: (msg, fatal) => log.errors.push([msg, fatal]),
      onConn: (st) => log.conn.push(st),
      onStatus: (t) => log.status.push(t),
      onEmote: (e) => log.emotes.push(e),
    });
    return { s, log, win: globalThis.window };
  };
  const settle = async (ms = 50) => { for (let i = 0; i < 5; i++) { await tickReal(); clock.advance(ms / 5); } };

  // host opens a room, a friend joins; the ICE list from config.js reaches PeerJS
  const H = mk({ mode: 'online', name: 'Hana', create: true });
  await settle();
  assert.equal(H.log.conn.at(-1), 'open');
  assert.equal(H.s.code.length, 5);
  assert.equal(codeProblem(H.s.code), null);
  assert.equal(H.log.lobby.joinUrl, 'https://example.org/minimaj/#' + H.s.code);
  assert.equal(H.win.sessionStorage.getItem('minimaj-host-code'), H.s.code);
  assert.ok(net0.opts[0].config.iceServers.some((x) => [].concat(x.urls).some((u) => /^stun:/.test(u))), 'STUN from config.js');
  const J = mk({ mode: 'online', name: 'Jun', code: H.s.code.toLowerCase() });
  await settle();
  assert.equal(J.log.conn.at(-1), 'open');
  assert.equal(H.log.lobby.members.length, 2);
  assert.equal(J.log.lobby.isHost, false);
  n++;

  // the host loses the room server mid-game: the friend's data channel keeps
  // working, the host hears about it once and is re-registered automatically
  H.s.start();
  await settle();
  assert.ok(J.log.view && H.log.view);
  const hostPeer = net0.ids.get('minimaj-v1-' + H.s.code);
  const jPeer = [...net0.ids.values()].find((p) => p.id.startsWith('anon'));
  net0.up = false;
  hostPeer._drop(); jPeer._drop();
  await settle(6000);
  assert.equal(J.log.conn.at(-1), 'open', 'joiner not dropped by a signaling outage');
  assert.equal(H.log.status.filter((x) => /server/.test(x)).length, 1, 'one notice per outage');
  net0.up = true;
  await settle(20000);
  assert.ok(net0.ids.get('minimaj-v1-' + H.s.code), 'host registered again');
  assert.ok(H.log.status.some((x) => /Back online/.test(x)));
  assert.equal(J.log.view.players[J.log.view.seat].kind, 'human');
  n++;

  // wrong code: a clear, fatal "not found" (no endless spinner)
  const W = mk({ mode: 'online', name: 'W', code: 'ZZZZZ' });
  await settle(200);
  assert.equal(W.log.errors.length, 1);
  assert.ok(/No room with the code ZZZZZ/.test(W.log.errors[0][0]) && W.log.errors[0][1]);
  assert.equal(W.log.conn.at(-1), 'closed');
  // impossible code: rejected before touching the network
  const B = mk({ mode: 'online', name: 'B', code: 'AB0DE' });
  await settle();
  assert.ok(/never contain/.test(B.log.errors[0][0]));
  n++;

  // a network that blocks peer-to-peer: a few tries, then say so
  net0.iceBlocked = true;
  const X = mk({ mode: 'online', name: 'X', code: H.s.code });
  for (let i = 0; i < 12; i++) await settle(5000);
  assert.equal(X.log.errors.length, 1, JSON.stringify(X.log));
  assert.ok(/blocks direct peer-to-peer/.test(X.log.errors[0][0]), X.log.errors[0][0]);
  assert.equal(X.log.conn.at(-1), 'closed');
  assert.ok(X.log.status.length >= 2, 'retried before giving up');
  net0.iceBlocked = false;
  n++;

  // the host reloads: the server still holds the old code for a while; the
  // new tab waits for it instead of opening a room nobody can find
  const oldCode = H.s.code;
  const hostWin = H.win;
  H.s.close(); J.s.close();
  await settle();
  net0.taken.set('minimaj-v1-' + oldCode, clock.now() + 7000);
  const H2 = mk({ mode: 'online', name: 'Hana', create: true }, { ...mkWindow(), sessionStorage: hostWin.sessionStorage });
  await settle(200);
  assert.ok(H2.log.status.some((x) => x.includes(oldCode)), 'tells the host it is waiting');
  for (let i = 0; i < 5; i++) await settle(2000);
  assert.equal(H2.s.code, oldCode);
  assert.equal(H2.log.conn.at(-1), 'open');
  assert.equal(H2.log.errors.length, 0);
  H2.s.close();
  n++;

  // no WebRTC at all (some in-app browsers): say so instead of failing oddly
  const N = mk({ mode: 'online', name: 'N', code: 'ABCDE' }, mkWindow({ RTCPeerConnection: undefined }));
  await settle();
  assert.ok(/WebRTC/.test(N.log.errors[0][0]));
  n++;

  // TURN credentials from an endpoint (window.MINIMAJ_NET / config.js iceUrl)
  let fetched = 0;
  def('fetch', async (url) => { fetched++; assert.equal(url, 'https://turn.example/creds'); return { ok: true, status: 200, json: async () => ({ iceServers: [{ urls: 'turn:t.example:3478', username: 'u', credential: 'c' }] }) }; });
  def('window', mkWindow({ MINIMAJ_NET: { iceUrl: 'https://turn.example/creds', iceServers: [{ urls: 'stun:s.example' }] } }));
  const list = await iceServers();
  assert.deepEqual(list.map((x) => x.urls), ['turn:t.example:3478', 'stun:s.example']);
  await iceServers();
  assert.equal(fetched, 1, 'credentials are cached');
  n++;

  clock.runAll(() => false, 2000);
  clock.uninstall();
  Date.now = realNow;
  for (const k of Object.keys(saved)) {
    if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k];
  }
  return n;
}
