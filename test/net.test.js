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
    const log = { lobby: null, view: null, errors: [], conn: [], status: [] };
    nextHostOk = hostOk;
    const info = { server: true, hostOk, lanUrls: ['http://192.168.1.5:7777'] };
    const s = createSession({ mode: 'lan', name, info }, {
      onLobby: (l) => { log.lobby = l; },
      onView: (v) => { log.view = v; },
      onError: (msg, fatal) => log.errors.push([msg, fatal]),
      onConn: (st) => log.conn.push(st),
      onStatus: (t) => log.status.push(t),
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
  return n;
}
