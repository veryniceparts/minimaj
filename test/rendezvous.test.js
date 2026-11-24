// Tests for js/mqtt.js and js/rendezvous.js, and for the PeerJS + MQTT race in
// js/net.js: an in-memory MQTT broker behind a fake WebSocket, fake
// RTCPeerConnection pairs, a fake PeerJS and the manual clock. WebCrypto is
// Node's real one (its promises settle on the real event loop, hence waitFor).
import assert from 'node:assert/strict';
import { installFakeClock } from './fakeclock.js';
import {
  encodeLength, createParser, publishPacket, parsePublish, connectPacket, subscribePacket, pingPacket,
} from '../js/mqtt.js';
import { hostRendezvous, dialRendezvous, roomKeys, seal } from '../js/rendezvous.js';

const B1 = 'wss://one.example/mqtt', B2 = 'wss://two.example:8884/mqtt', B3 = 'wss://three.example/mqtt';

/* ---------------- fakes ---------------- */

// An MQTT broker per URL. mode 'chop' splits every frame it sends into small
// pieces, 'merge' sends everything queued in one tick as one frame.
function makeBrokers() {
  const brokers = new Map();
  const get = (url) => {
    if (!brokers.has(url)) brokers.set(url, { up: true, socks: new Set(), log: [], mode: null, connects: 0 });
    return brokers.get(url);
  };
  class FakeMqttWS {
    constructor(url, proto) {
      assert.equal(proto, 'mqtt');
      this.url = url; this.readyState = 0; this.subs = new Set(); this.b = get(url); this.out = null;
      this.parser = createParser((type, flags, body) => this._packet(type, flags, body));
      setTimeout(() => {
        if (this.readyState !== 0) return;
        if (!this.b.up) { this.readyState = 3; if (this.onclose) this.onclose({}); return; }
        this.readyState = 1; this.b.socks.add(this);
        if (this.onopen) this.onopen({});
      }, 3);
    }
    send(bytes) {
      assert.equal(this.readyState, 1);
      assert.ok(bytes instanceof Uint8Array);
      const copy = bytes.slice();
      setTimeout(() => { if (this.readyState === 1) this.parser.push(copy); }, 1);
    }
    _packet(type, flags, body) {
      if (type === 1) {
        assert.deepEqual([...body.slice(0, 8)], [0, 4, 77, 81, 84, 84, 4, 2], 'CONNECT: MQTT 3.1.1, clean session');
        this.b.connects++;
        this._deliver([0x20, 2, 0, 0]);
      } else if (type === 8) {
        assert.equal(flags, 2);
        let i = 2; const granted = [];
        while (i < body.length) { const l = (body[i] << 8) | body[i + 1]; this.subs.add(new TextDecoder().decode(body.subarray(i + 2, i + 2 + l))); i += 3 + l; granted.push(0); }
        this._deliver([0x90, 2 + granted.length, body[0], body[1], ...granted]);
      } else if (type === 10) {
        let i = 2;
        while (i < body.length) { const l = (body[i] << 8) | body[i + 1]; this.subs.delete(new TextDecoder().decode(body.subarray(i + 2, i + 2 + l))); i += 2 + l; }
        this._deliver([0xb0, 2, body[0], body[1]]);
      } else if (type === 3) {
        const m = parsePublish(flags, body);
        this.b.log.push(m);
        for (const s of this.b.socks) if (s.subs.has(m.topic)) s._deliver(publishPacket(m.topic, m.payload));
      } else if (type === 12) this._deliver([0xd0, 0]);
      else if (type === 14) this.close();
    }
    _deliver(bytes) {
      const data = Uint8Array.from(bytes);
      const frame = (d) => setTimeout(() => { if (this.readyState === 1 && this.onmessage) this.onmessage({ data: d.slice().buffer }); }, 1);
      if (this.b.mode === 'chop') {
        for (let i = 0; i < data.length;) { const n = 1 + ((i * 7) % 5); frame(data.subarray(i, i + n)); i += n; }
      } else if (this.b.mode === 'merge') {
        if (!this.out) { this.out = []; setTimeout(() => { const all = this.out.flatMap((x) => [...x]); this.out = null; frame(Uint8Array.from(all)); }, 0); }
        this.out.push(data);
      } else frame(data);
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3; this.b.socks.delete(this);
      setTimeout(() => { if (this.onclose) this.onclose({}); }, 1);
    }
  }
  const kill = (url) => { const b = get(url); b.up = false; for (const s of [...b.socks]) s.close(); };
  return { FakeMqttWS, get, kill };
}

// RTCPeerConnection pairs: the answer names the offering peer, and setting it
// links the two (or fails ICE on both when rtc.blocked).
function makeRtc() {
  const rtc = { blocked: false, pcs: new Map(), created: [] };
  let seq = 0;
  class FakeDC {
    constructor(label) { this.label = label; this.readyState = 'connecting'; this.other = null; }
    send(s) {
      if (this.readyState !== 'open') throw new Error('not open');
      const o = this.other;
      setTimeout(() => { if (o.readyState === 'open' && o.onmessage) o.onmessage({ data: s }); }, 1);
    }
    close() {
      if (this.readyState === 'closed') return;
      this.readyState = 'closed';
      setTimeout(() => { if (this.onclose) this.onclose({}); }, 0);
      if (this.other) this.other._remoteClose();
    }
    _remoteClose() { if (this.readyState === 'closed') return; this.readyState = 'closed'; setTimeout(() => { if (this.onclose) this.onclose({}); }, 1); }
    _open() { this.readyState = 'open'; if (this.onopen) this.onopen({}); }
  }
  class FakePC {
    constructor(cfg) {
      this.cfg = cfg; this.id = ++seq; this.closed = false; this.dc = null;
      this.localDescription = null; this.remoteDescription = null;
      this.iceGatheringState = 'new'; this.connectionState = 'new'; this.iceConnectionState = 'new';
      rtc.pcs.set(this.id, this); rtc.created.push(this);
    }
    createDataChannel(label, o) { assert.equal(o.ordered, true); this.dc = new FakeDC(label); return this.dc; }
    async createOffer() { return { type: 'offer', sdp: 'offer:' + this.id }; }
    async createAnswer() { return { type: 'answer', sdp: 'answer:' + this.remoteDescription.sdp.split(':')[1] + ':' + this.id }; }
    async setLocalDescription(d) {
      this.localDescription = d; this.iceGatheringState = 'gathering';
      setTimeout(() => {
        this.iceGatheringState = 'complete';
        if (this.onicegatheringstatechange) this.onicegatheringstatechange({});
        if (this.onicecandidate) this.onicecandidate({ candidate: null });
      }, 20);
    }
    async setRemoteDescription(d) {
      if (!d || typeof d.sdp !== 'string') throw new Error('bad description');
      this.remoteDescription = d;
      if (d.type === 'answer') { const host = rtc.pcs.get(+d.sdp.split(':')[2]); setTimeout(() => this._link(host), 5); }
    }
    async addIceCandidate() {}
    _link(host) {
      if (this.closed || !host || host.closed) return;
      if (rtc.blocked) {
        for (const pc of [this, host]) { pc.iceConnectionState = 'failed'; pc.connectionState = 'failed'; if (pc.onconnectionstatechange) pc.onconnectionstatechange({}); }
        return;
      }
      const a = this.dc, b = new FakeDC(a.label);
      a.other = b; b.other = a; host.dc = b;
      this.connectionState = host.connectionState = 'connected';
      if (host.ondatachannel) host.ondatachannel({ channel: b });
      b._open(); a._open();
    }
    close() { this.closed = true; this.connectionState = 'closed'; if (this.dc) this.dc.close(); }
  }
  rtc.RTCPeerConnection = FakePC;
  rtc.openChannels = () => rtc.created.filter((pc) => pc.dc && pc.dc.readyState === 'open' && !pc.closed).length;
  return rtc;
}

// a compact fake PeerJS (see test/net.test.js), with a settable dial delay
function makePeerJS(clock) {
  const net0 = { ids: new Map(), up: true, dialMs: 3, conns: [], peers: [], registrations: 0 };
  class Em {
    constructor() { this.h = {}; }
    on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; }
    emit(e, ...a) { for (const f of (this.h[e] || []).slice()) f(...a); }
  }
  class Conn extends Em {
    constructor(peerId) { super(); this.peer = peerId; this.open = false; this.other = null; this.peerConnection = { iceConnectionState: 'new' }; net0.conns.push(this); }
    send(d) { const o = this.other; const copy = JSON.parse(JSON.stringify(d)); setTimeout(() => { if (o && o.open) o.emit('data', copy); }, 1); }
    close() { if (!this.open && !this.other) return; const o = this.other; this.other = null; const was = this.open; this.open = false; if (was) this.emit('close'); if (o) o.close(); }
  }
  let anon = 0;
  class FakePeer extends Em {
    constructor(id, opts) {
      super();
      if (id && typeof id === 'object') { opts = id; id = null; }
      this.id = id || 'anon' + ++anon; this.open = false; this.disconnected = false; this.destroyed = false;
      this.zombie = false; // its signaling socket died silently: dials go nowhere, nothing says so
      net0.peers.push(this);
      setTimeout(() => this._register(), 5);
    }
    _register() {
      if (this.destroyed || net0.blackhole) return; // blackhole: the server accepts the socket and never answers
      if (!net0.up) { this.emit('error', { type: 'network' }); this.disconnected = true; this.emit('disconnected'); return; }
      if (net0.ids.has(this.id) && net0.ids.get(this.id) !== this) { this.emit('error', { type: 'unavailable-id' }); this.disconnected = true; this.emit('disconnected'); return; }
      net0.ids.set(this.id, this); this.open = true; this.disconnected = false; net0.registrations++; this.emit('open', this.id);
    }
    disconnect() { if (this.disconnected) return; this.emit('disconnected', this.id); this.disconnected = true; this.open = false; if (net0.ids.get(this.id) === this) net0.ids.delete(this.id); }
    reconnect() { this.disconnected = false; setTimeout(() => this._register(), 5); }
    connect(id) {
      const c = new Conn(id);
      if (this.zombie) return c;
      setTimeout(() => {
        const host = net0.ids.get(id);
        if (!host || !net0.up) { this.emit('error', { type: 'peer-unavailable' }); return; }
        const hc = new Conn(this.id);
        c.other = hc; hc.other = c;
        host.emit('connection', hc);
        setTimeout(() => { if (!c.other) return; hc.open = true; c.open = true; hc.emit('open'); c.emit('open'); }, net0.dialMs);
      }, 3);
      return c;
    }
    destroy() { this.destroyed = true; this.open = false; if (net0.ids.get(this.id) === this) net0.ids.delete(this.id); }
  }
  net0.Peer = FakePeer;
  net0.openConns = () => net0.conns.filter((c) => c.open).length;
  return net0;
}

const tickReal = () => new Promise((r) => setImmediate(r));

/* ---------------- tests ---------------- */

export async function runRendezvousTests() {
  let n = 0;
  const t = async (name, fn) => { try { await fn(); n++; } catch (e) { e.message = `rendezvous: ${name}: ${e.message}`; throw e; } };

  await t('mqtt packet encoding and stream parsing', () => {
    const cases = [[0, [0]], [127, [127]], [128, [128, 1]], [16383, [255, 127]], [16384, [128, 128, 1]],
      [2097151, [255, 255, 127]], [2097152, [128, 128, 128, 1]], [268435455, [255, 255, 255, 127]]];
    for (const [v, bytes] of cases) assert.deepEqual(encodeLength(v), bytes, String(v));
    assert.throws(() => encodeLength(268435456));
    // PUBLISH QoS 0 "a/b" "hi": 0x30, len 7, topic length 3, topic, payload
    assert.deepEqual([...publishPacket('a/b', 'hi')], [0x30, 7, 0, 3, 97, 47, 98, 104, 105]);
    assert.deepEqual([...pingPacket()], [0xc0, 0]);
    assert.deepEqual([...subscribePacket(5, ['x'])], [0x82, 6, 0, 5, 0, 1, 120, 0]);
    const c = connectPacket('cid', 30);
    assert.deepEqual([...c], [0x10, 15, 0, 4, 77, 81, 84, 84, 4, 2, 0, 30, 0, 3, 99, 105, 100]);

    // a big payload (2-byte remaining length), unicode, merged and split frames
    const big = 'x'.repeat(300) + '麻雀';
    const stream = [...publishPacket('t/1', big), ...pingPacket(), ...publishPacket('t/2', '{"a":1}'), 0x20, 2, 0, 0];
    const parse = (chunks) => {
      const got = [];
      const p = createParser((type, flags, body) => got.push(type === 3 ? parsePublish(flags, body).topic + '=' + parsePublish(flags, body).payload : type));
      for (const ch of chunks) p.push(Uint8Array.from(ch));
      return got;
    };
    const want = ['t/1=' + big, 12, 't/2={"a":1}', 2];
    assert.deepEqual(parse([stream]), want, 'all in one frame');
    assert.deepEqual(parse(stream.map((b) => [b])), want, 'one byte per frame');
    for (const cut of [1, 2, 3, 150, 306, 310]) assert.deepEqual(parse([stream.slice(0, cut), stream.slice(cut)]), want, 'cut at ' + cut);
    // QoS 1 publish from a broker: packet id skipped
    const q1 = [0x32, 9, 0, 3, 97, 47, 98, 0, 7, 104, 105];
    const got = [];
    createParser((type, flags, body) => got.push(parsePublish(flags, body))).push(Uint8Array.from(q1));
    assert.deepEqual(got[0], { topic: 'a/b', payload: 'hi', qos: 1, id: 7 });
  });

  const clock = installFakeClock();
  const realNow = Date.now;
  Date.now = clock.now;
  const saved = {};
  for (const k of ['window', 'document', 'location']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  // WebCrypto works on other threads: count calls in flight, so the fake clock
  // only moves on once they have finished (otherwise timeouts fire early)
  const subtle = globalThis.crypto.subtle;
  let inflight = 0;
  const wrapped = ['digest', 'importKey', 'encrypt', 'decrypt'];
  for (const k of wrapped) {
    const f = subtle[k].bind(subtle);
    subtle[k] = (...a) => { inflight++; return f(...a).finally(() => { inflight--; }); };
  }
  // advance the fake clock in small steps, letting WebCrypto's promises settle in between
  const waitFor = async (cond, ms, step = 5) => {
    for (let waited = 0; waited <= ms; waited += step) {
      if (cond()) return true;
      await tickReal();
      for (let i = 0; inflight && i < 100000; i++) await tickReal();
      clock.advance(step);
    }
    return cond();
  };
  const run = (ms) => waitFor(() => false, ms, Math.max(5, Math.floor(ms / 400)));

  try {
    await t('mqtt client: subscribe, publish, frames split or merged, reconnect', async () => {
      const { FakeMqttWS, get, kill } = makeBrokers();
      const { mqttConnect } = await import('../js/mqtt.js');
      get(B1).mode = 'chop';
      const states = [];
      const a = mqttConnect(B1, { WebSocket: FakeMqttWS, onStatus: (v) => states.push(v) });
      const b = mqttConnect(B1, { WebSocket: FakeMqttWS });
      const got = [];
      a.subscribe('room/x', (p) => got.push(p));
      await waitFor(() => a.connected && b.connected, 200);
      assert.deepEqual(states, [true]);
      await run(20);
      assert.equal(b.publish('room/x', 'hello'), true);
      assert.equal(b.publish('room/y', 'nobody'), true);
      await run(20);
      assert.deepEqual(got, ['hello']);
      get(B1).mode = 'merge';
      for (let i = 0; i < 5; i++) b.publish('room/x', 'm' + i);
      await run(20);
      assert.deepEqual(got.slice(1), ['m0', 'm1', 'm2', 'm3', 'm4']);
      // keepalive pings keep the link up
      await run(70000);
      assert.equal(a.connected, true);
      // the broker restarts: the client reconnects with backoff and subscribes again
      kill(B1);
      await run(20);
      assert.equal(a.connected, false);
      assert.equal(a.publish('room/x', 'lost'), false);
      get(B1).up = true;
      await waitFor(() => a.connected && b.connected, 40000);
      await run(20);
      b.publish('room/x', 'again');
      await run(20);
      assert.equal(got.at(-1), 'again');
      a.close(); b.close();
      await run(20);
      assert.equal(get(B1).socks.size, 0);
      assert.deepEqual(states, [true, false, true, false]);
    });

    await t('guest joins host over MQTT, data both ways, one broker down', async () => {
      const { FakeMqttWS, get, kill } = makeBrokers();
      const rtc = makeRtc();
      kill(B2);
      const env = { brokers: [B1, B2], WebSocket: FakeMqttWS, RTCPeerConnection: rtc.RTCPeerConnection, iceServers: [{ urls: 'stun:s.example' }] };
      const conns = [];
      const host = hostRendezvous({ ...env, code: 'ABCDE', onConnection: (c) => conns.push(c) });
      host.active = true;
      await waitFor(() => host.brokersUp === 1, 500);
      const g = dialRendezvous({ ...env, code: 'ABCDE' });
      let opened = false;
      const gData = [], hData = [];
      g.on('open', () => { opened = true; });
      g.on('error', (e) => assert.fail('guest error ' + e.type));
      g.on('data', (d) => gData.push(d));
      await waitFor(() => opened, 5000);
      assert.equal(opened, true);
      assert.equal(conns.length, 1);
      const hc = conns[0];
      assert.equal(hc.open, true);
      hc.on('data', (d) => hData.push(d));
      g.send({ t: 'hello', n: 1 });
      hc.send({ t: 'lobby', x: [1, 2] });
      await run(20);
      assert.deepEqual(hData, [{ t: 'hello', n: 1 }]);
      assert.deepEqual(gData, [{ t: 'lobby', x: [1, 2] }]);
      assert.ok(rtc.created.every((pc) => pc.cfg.iceServers[0].urls === 'stun:s.example'), 'ICE servers passed on');
      // only noise on the broker: hashed topic, encrypted payloads
      const log = get(B1).log;
      assert.ok(log.length >= 3 && log.every((m) => /^minimaj\/v1\/[0-9a-f]{24}\/(host|g\/[0-9a-f]{16}|alive)$/.test(m.topic)), log.map((m) => m.topic).join());
      assert.ok(log.every((m) => !/ABCDE|offer|sdp/.test(m.payload)));
      // the guest's signaling sockets are closed once the channel is open
      await run(50);
      assert.equal(get(B1).socks.size, 1, 'only the host stays on the broker');
      // close from the guest: the host side sees 'close'
      let closed = 0;
      hc.on('close', () => closed++);
      g.close();
      await run(20);
      assert.equal(closed, 1);
      host.close();
    });

    await t('other rooms, wrong keys and tampered messages are ignored', async () => {
      const { FakeMqttWS, get } = makeBrokers();
      const rtc = makeRtc();
      const env = { brokers: [B1], WebSocket: FakeMqttWS, RTCPeerConnection: rtc.RTCPeerConnection, iceServers: [] };
      const conns = [];
      const host = hostRendezvous({ ...env, code: 'ABCDE', onConnection: (c) => conns.push(c) });
      host.active = true;
      await waitFor(() => host.brokersUp === 1, 500);
      // junk, a message sealed with another room's key, and a tampered real one, all on the host topic
      const { base } = await roomKeys('ABCDE');
      const other = await roomKeys('ZZZZZ');
      const { mqttConnect } = await import('../js/mqtt.js');
      const evil = mqttConnect(B1, { WebSocket: FakeMqttWS });
      await waitFor(() => evil.connected, 200);
      const offer = { t: 'offer', g: 'ffffffffffffffff', o: 'aaaa', sdp: { type: 'offer', sdp: 'offer:999' }, id: 'x1', ts: Date.now() };
      evil.publish(base + '/host', 'not base64 at all!');
      evil.publish(base + '/host', await seal(other.key, offer));
      const real = await seal((await roomKeys('ABCDE')).key, { ...offer, id: 'x2' });
      const bytes = Uint8Array.from(atob(real), (c) => c.charCodeAt(0));
      bytes[20] ^= 1;
      evil.publish(base + '/host', btoa(String.fromCharCode(...bytes)));
      // a stale (replayed) offer with the right key
      evil.publish(base + '/host', await seal((await roomKeys('ABCDE')).key, { ...offer, id: 'x3', ts: Date.now() - 120000 }));
      await run(200);
      assert.equal(rtc.created.length, 0, 'no peer connection for junk');
      // a guest dialing another code finds nobody
      const g = dialRendezvous({ ...env, code: 'ZZZZZ' });
      let err = null;
      g.on('error', (e) => { err = e; });
      g.on('open', () => assert.fail('opened another room'));
      await waitFor(() => err, 15000);
      assert.equal(err.type, 'peer-unavailable');
      assert.equal(conns.length, 0);
      evil.close(); host.close();
      await run(20);
      assert.equal(get(B1).socks.size, 0);
    });

    await t('guest errors: no host, no broker, ICE blocked', async () => {
      const { FakeMqttWS, kill } = makeBrokers();
      const rtc = makeRtc();
      const env = { brokers: [B1, B2], WebSocket: FakeMqttWS, RTCPeerConnection: rtc.RTCPeerConnection, iceServers: [] };
      const dial = async (code, ms = 20000) => {
        const g = dialRendezvous({ ...env, code });
        let res = null;
        g.on('error', (e) => { res = res || e.type; });
        g.on('open', () => { res = res || 'open'; });
        const t0 = clock.now();
        await waitFor(() => res, ms);
        return [res, clock.now() - t0];
      };
      const [r1, ms1] = await dial('QQQQQ');
      assert.equal(r1, 'peer-unavailable');
      assert.ok(ms1 < 9000, 'not found within ' + ms1);
      // a host that is not ready yet (code not settled) does not answer either
      const host = hostRendezvous({ ...env, code: 'HHHHH', onConnection: () => {} });
      await waitFor(() => host.brokersUp === 2, 500);
      assert.equal((await dial('HHHHH'))[0], 'peer-unavailable');
      host.active = true;
      rtc.blocked = true;
      assert.equal((await dial('HHHHH'))[0], 'negotiation-failed');
      rtc.blocked = false;
      assert.equal((await dial('HHHHH'))[0], 'open');
      host.close();
      kill(B1); kill(B2);
      assert.equal((await dial('HHHHH'))[0], 'signal');
      // no WebRTC: the route reports it at once
      const g = dialRendezvous({ ...env, RTCPeerConnection: undefined, code: 'ABCDE' });
      let e2 = null;
      g.on('error', (e) => { e2 = e.type; });
      await run(10);
      assert.equal(e2, 'browser-incompatible');
    });

    /* ---------- js/net.js: both routes ---------- */

    const docL = [], winL = [];
    const doc = { visibilityState: 'visible', addEventListener: (e, f) => docL.push(f), removeEventListener: (e, f) => { const i = docL.indexOf(f); if (i >= 0) docL.splice(i, 1); } };
    def('document', doc);
    const setVisible = (v) => { doc.visibilityState = v ? 'visible' : 'hidden'; for (const f of docL.slice()) f(); };
    def('location', { protocol: 'https:', host: 'example.org', origin: 'https://example.org', pathname: '/' });
    const { createSession } = await import('../js/net.js');
    const mkStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
    const world = () => {
      const brokers = makeBrokers();
      const rtc = makeRtc();
      const pj = makePeerJS(clock);
      return { brokers, rtc, pj };
    };
    const mk = (w, opts, cfg = {}, extra = {}) => {
      def('window', {
        localStorage: mkStore(), sessionStorage: mkStore(), Peer: w.pj.Peer,
        RTCPeerConnection: w.rtc.RTCPeerConnection, WebSocket: w.brokers.FakeMqttWS,
        MINIMAJ_NET: { mqtt: [B1, B2], ...cfg },
        addEventListener: (e, f) => winL.push([e, f]),
        removeEventListener: (e, f) => { const i = winL.findIndex((x) => x[1] === f); if (i >= 0) winL.splice(i, 1); },
        ...extra,
      });
      const log = { lobby: null, errors: [], conn: [], status: [] };
      const s = createSession(opts, {
        onLobby: (l) => { log.lobby = l; },
        onError: (msg, fatal, info) => { log.errors.push([msg, fatal]); if (info && info.notFound) log.notFound = info.notFound; },
        onConn: (st) => log.conn.push(st),
        onStatus: (x) => log.status.push(x),
      });
      return { s, log, win: globalThis.window };
    };

    await t('net: rooms over MQTT alone (peerjs: false)', async () => {
      const w = world();
      const H = mk(w, { mode: 'online', name: 'Hana', create: true }, { peerjs: false });
      await waitFor(() => H.log.conn.at(-1) === 'open', 3000);
      assert.equal(H.log.conn.at(-1), 'open');
      assert.equal(H.s.code.length, 5);
      assert.equal(w.pj.ids.size, 0, 'PeerJS not used');
      const J = mk(w, { mode: 'online', name: 'Jun', code: H.s.code }, { peerjs: false });
      await waitFor(() => H.log.lobby && H.log.lobby.members.length === 2, 8000);
      assert.equal(J.log.conn.at(-1), 'open');
      assert.equal(J.log.lobby.isHost, false);
      assert.equal(w.rtc.openChannels(), 2);
      // pings flow over the data channel: still connected much later
      await run(30000);
      assert.equal(J.log.conn.at(-1), 'open');
      assert.deepEqual(J.log.conn, ['connecting', 'open']);
      // the host's brokers go down: one notice, the game goes on; back up: "Back online"
      w.brokers.kill(B1); w.brokers.kill(B2);
      await run(3000);
      assert.equal(H.log.status.filter((x) => /Lost the online-room server/.test(x)).length, 1);
      assert.equal(J.log.conn.at(-1), 'open');
      w.brokers.get(B1).up = true;
      await waitFor(() => H.log.status.some((x) => /Back online/.test(x)), 40000);
      assert.ok(H.log.status.some((x) => /Back online/.test(x)));
      // the guest drops (its channel closes): it reconnects over MQTT and keeps its seat
      const seat = J.log.lobby.members.length;
      w.rtc.created.filter((pc) => pc.dc && pc.dc.readyState === 'open').forEach((pc) => pc.close());
      await waitFor(() => J.log.conn.at(-1) === 'reconnecting', 2000);
      await waitFor(() => J.log.conn.at(-1) === 'open', 20000);
      assert.equal(J.log.conn.at(-1), 'open');
      await run(100);
      assert.equal(H.log.lobby.members.length, seat);
      H.s.close(); J.s.close();
      await run(50);
    });

    await t('net: PeerJS and MQTT race, one transport, the other closed', async () => {
      for (const slowPeer of [false, true]) {
        const w = world();
        const H = mk(w, { mode: 'online', name: 'Hana', create: true });
        await waitFor(() => H.log.conn.at(-1) === 'open', 3000);
        assert.ok(w.pj.ids.has('minimaj-v1-' + H.s.code), 'registered with PeerJS');
        await waitFor(() => w.brokers.get(B1).socks.size === 1, 500);
        if (slowPeer) w.pj.dialMs = 4000; // the MQTT route wins
        const J = mk(w, { mode: 'online', name: 'Jun', code: H.s.code });
        await waitFor(() => H.log.lobby && H.log.lobby.members.length === 2, 8000);
        await run(6000);
        assert.equal(J.log.conn.at(-1), 'open');
        const peerOpen = w.pj.openConns(), rtcOpen = w.rtc.openChannels();
        assert.equal(slowPeer ? rtcOpen : peerOpen, 2, 'winner open on both ends');
        assert.equal(slowPeer ? peerOpen : rtcOpen, 0, 'loser closed');
        assert.equal(H.log.lobby.members.length, 2);
        await run(20000);
        assert.deepEqual(J.log.conn, ['connecting', 'open']);
        H.s.close(); J.s.close();
        await run(50);
      }
    });

    await t('net: the PeerJS server is unreachable: the room opens over MQTT', async () => {
      const w = world();
      w.pj.up = false;
      const H = mk(w, { mode: 'online', name: 'Hana', create: true });
      await waitFor(() => H.log.conn.at(-1) === 'open', 5000);
      assert.equal(H.log.conn.at(-1), 'open');
      assert.equal(H.log.errors.length, 0);
      const code = H.s.code;
      assert.equal(code.length, 5);
      const J = mk(w, { mode: 'online', name: 'Jun', code });
      await waitFor(() => H.log.lobby && H.log.lobby.members.length === 2, 15000);
      assert.equal(J.log.conn.at(-1), 'open');
      assert.equal(J.log.errors.length, 0);
      // PeerJS comes back: the host registers the same code quietly
      w.pj.up = true;
      await waitFor(() => w.pj.ids.has('minimaj-v1-' + code), 40000);
      assert.ok(w.pj.ids.has('minimaj-v1-' + code));
      assert.equal(H.log.status.filter((x) => /Lost the online-room server/.test(x)).length, 0, 'no outage notice while MQTT works');
      H.s.close(); J.s.close();
      await run(50);
    });

    await t('net: a blackholed PeerJS server delays nothing', async () => {
      const w = world();
      w.pj.blackhole = true;
      let t0 = clock.now();
      const H = mk(w, { mode: 'online', name: 'Hana', create: true });
      await waitFor(() => H.log.conn.at(-1) === 'open', 20000);
      assert.ok(clock.now() - t0 < 1000, 'room open in ' + (clock.now() - t0) + ' ms');
      const code = H.s.code;
      t0 = clock.now();
      const J = mk(w, { mode: 'online', name: 'Jun', code });
      await waitFor(() => J.log.lobby, 20000);
      assert.ok(clock.now() - t0 < 1500, 'guest in after ' + (clock.now() - t0) + ' ms');
      // the host reloads: same code at once, and the guest is back within seconds
      H.s.close();
      await run(100);
      t0 = clock.now();
      const H2 = mk(w, { mode: 'online', name: 'Hana', create: true }, {}, { sessionStorage: H.win.sessionStorage });
      await waitFor(() => H2.log.conn.at(-1) === 'open', 20000);
      assert.equal(H2.s.code, code);
      assert.ok(clock.now() - t0 < 1000, 'reopened in ' + (clock.now() - t0) + ' ms');
      await waitFor(() => H2.log.lobby && H2.log.lobby.members.length === 2, 30000);
      assert.ok(clock.now() - t0 < 6000, 'guest back after ' + (clock.now() - t0) + ' ms');
      assert.equal(J.log.errors.length, 0);
      // the host is gone for a while: attempts end when MQTT says "no such room",
      // not when the hung PeerJS route times out
      H2.s.close();
      await waitFor(() => J.log.conn.at(-1) === 'reconnecting', 2000);
      const n0 = J.log.status.length;
      await run(30000);
      assert.ok(J.log.status.length - n0 >= 3, 'attempts in 30 s: ' + (J.log.status.length - n0));
      assert.equal(J.log.errors.length, 0);
      const H4 = mk(w, { mode: 'online', name: 'Hana', create: true }, {}, { sessionStorage: H.win.sessionStorage });
      await waitFor(() => H4.log.lobby && H4.log.lobby.members.length === 2, 30000);
      assert.equal(H4.s.code, code);
      // no brokers either: the host says so after ~15 s instead of hanging
      const w2 = world();
      w2.pj.blackhole = true;
      t0 = clock.now();
      const H3 = mk(w2, { mode: 'online', name: 'Hana', create: true }, { mqtt: [] });
      await waitFor(() => H3.log.errors.length, 60000);
      assert.ok(/any online-room server/.test(H3.log.errors[0][0]), H3.log.errors[0][0]);
      assert.ok(clock.now() - t0 < 17000, 'failed after ' + (clock.now() - t0) + ' ms');
      assert.equal(H3.log.conn.at(-1), 'closed');
      H4.s.close(); J.s.close();
      await run(50);
    });

    await t('net: the code is held by someone else on PeerJS: the MQTT room keeps it', async () => {
      const w = world();
      const stranger = new w.pj.Peer('minimaj-v1-KEEPS', {});
      await run(20);
      const warn = console.warn;
      const warned = [];
      console.warn = (m) => warned.push(m);
      try {
        const H = mk(w, { mode: 'online', name: 'Hana', create: true, code: 'KEEPS' });
        await waitFor(() => H.log.conn.at(-1) === 'open', 5000);
        assert.equal(H.s.code, 'KEEPS');
        await run(90000);
        assert.equal(H.s.code, 'KEEPS', 'no code switch under the guests');
        assert.equal(H.log.conn.at(-1), 'open');
        assert.ok(warned.some((m) => /KEEPS/.test(m)), 'logged');
        assert.equal(w.pj.ids.get('minimaj-v1-KEEPS'), stranger);
        // MQTT guests still get in
        const J = mk(w, { mode: 'online', name: 'Jun', code: 'KEEPS' }, { peerjs: false });
        await waitFor(() => H.log.lobby && H.log.lobby.members.length === 2, 10000);
        assert.equal(J.log.conn.at(-1), 'open');
        H.s.close(); J.s.close();
        await run(50);
      } finally { console.warn = warn; }
    });

    await t('net: error texts when every route fails', async () => {
      // nothing reachable at all: host and guest both say so
      const w = world();
      w.pj.up = false; w.brokers.kill(B1); w.brokers.kill(B2);
      const H = mk(w, { mode: 'online', name: 'Hana', create: true });
      await waitFor(() => H.log.errors.length, 40000);
      assert.ok(/any online-room server/.test(H.log.errors[0][0]), H.log.errors[0][0]);
      assert.equal(H.log.conn.at(-1), 'closed');
      const J = mk(w, { mode: 'online', name: 'Jun', code: 'ABCDE' });
      await waitFor(() => J.log.errors.length, 80000);
      assert.ok(/any online-room server/.test(J.log.errors[0][0]), J.log.errors[0][0]);
      // servers fine, no such room: "not found" from both routes
      const w2 = world();
      const W = mk(w2, { mode: 'online', name: 'W', code: 'ZZZZZ' });
      await waitFor(() => W.log.errors.length, 20000);
      assert.ok(/No room with the code ZZZZZ/.test(W.log.errors[0][0]), W.log.errors[0][0]);
      assert.equal(W.log.notFound, 'ZZZZZ');
      // PeerJS unreachable, MQTT says no such room: still "not found"
      w2.pj.up = false;
      const W2 = mk(w2, { mode: 'online', name: 'W', code: 'YYYYY' });
      await waitFor(() => W2.log.errors.length, 20000);
      assert.ok(/No room with the code YYYYY/.test(W2.log.errors[0][0]), W2.log.errors[0][0]);
      // a host exists but WebRTC fails: the peer-to-peer message
      w2.pj.up = true;
      const H2 = mk(w2, { mode: 'online', name: 'Hana', create: true }, { peerjs: false });
      await waitFor(() => H2.log.conn.at(-1) === 'open', 3000);
      w2.rtc.blocked = true;
      const X = mk(w2, { mode: 'online', name: 'X', code: H2.s.code }, { peerjs: false });
      await waitFor(() => X.log.errors.length, 80000);
      assert.ok(/blocks direct peer-to-peer/.test(X.log.errors[0][0]), X.log.errors[0][0]);
      H2.s.close();
      await run(50);
    });
    await t('net: a frozen guest tab is not a dead link', async () => {
      // a bare host that never times anybody out (the real room shares our clock)
      const w = world();
      const conns = [];
      const host = hostRendezvous({
        code: 'FRZNA', brokers: [B1, B2], WebSocket: w.brokers.FakeMqttWS, RTCPeerConnection: w.rtc.RTCPeerConnection, iceServers: [],
        onConnection: (c) => {
          conns.push(c);
          c.on('data', (m) => {
            if (m.t === 'hello') c.send({ t: 'lobby', lobby: { isHost: false, members: [{}, {}] } });
            if (m.t === 'ping') c.send({ t: 'pong', n: m.n });
          });
        },
      });
      host.active = true;
      const J = mk(w, { mode: 'online', name: 'Jun', code: 'FRZNA' }, { peerjs: false });
      await waitFor(() => J.log.lobby, 8000);
      assert.equal(J.log.conn.at(-1), 'open');
      let skew = 0;
      Date.now = () => clock.now() + skew;
      skew += 30000; // timers did not run for 30 s
      await run(3000);
      assert.deepEqual(J.log.conn, ['connecting', 'open'], 'no drop after a freeze');
      // back from the background with old timestamps: a few seconds' grace, then pongs
      setVisible(false); skew += 25000; setVisible(true);
      assert.equal(J.log.conn.at(-1), 'open');
      await run(3000);
      assert.deepEqual(J.log.conn, ['connecting', 'open']);
      // a link that really is dead is still noticed (20 s)
      for (const c of conns) c.send = () => {};
      await run(16000); // the last pong came up to 3 s before
      assert.deepEqual(J.log.conn, ['connecting', 'open'], 'not after a 16 s stall');
      await run(6000);
      assert.ok(J.log.conn.includes('reconnecting'), 'dropped: ' + J.log.conn.join());
      J.s.close(); host.close();
      Date.now = clock.now; // (after the sessions: time must not run backwards for them)
      await run(50);
    });

    await t('net: dead signaling, network changes, half-open connections', async () => {
      const w = world();
      const pjOnly = { mqtt: [] };
      const H = mk(w, { mode: 'online', name: 'Hana', create: true }, pjOnly);
      await waitFor(() => H.log.conn.at(-1) === 'open', 3000);
      const J = mk(w, { mode: 'online', name: 'Jun', code: H.s.code }, pjOnly);
      await waitFor(() => H.log.lobby && H.log.lobby.members.length === 2, 3000);
      assert.equal(J.log.conn.at(-1), 'open');

      // the guest's PeerJS socket dies silently (VPN reconnect), then its data
      // channel drops: the reconnect must not dial through the dead Peer
      const gPeer = w.pj.peers.find((p) => p.id.startsWith('anon') && !p.destroyed);
      gPeer.zombie = true;
      const live = w.pj.conns.filter((c) => c.open && c.peer.startsWith('minimaj'));
      assert.equal(live.length, 1);
      live[0].close();
      await waitFor(() => J.log.conn.at(-1) === 'reconnecting', 1000);
      await waitFor(() => J.log.conn.at(-1) === 'open', 15000);
      assert.equal(J.log.conn.at(-1), 'open', 'back in with a fresh Peer');
      assert.ok(gPeer.destroyed, 'the old Peer was dropped');

      // the host was hidden for a while: it registers again on a fresh socket, quietly
      const regs = w.pj.registrations;
      setVisible(false); await run(25000); setVisible(true);
      await run(200);
      assert.ok(w.pj.registrations > regs, 're-registered');
      assert.ok(w.pj.ids.has('minimaj-v1-' + H.s.code));
      assert.equal(H.log.status.filter((x) => /Lost the online-room server/.test(x)).length, 0);

      // a dial whose channel never opens: the host drops it after 30 s
      w.pj.dialMs = 1e9;
      const Z = mk(w, { mode: 'online', name: 'Z', code: H.s.code }, pjOnly);
      await run(200);
      const half = w.pj.conns.filter((c) => c.peer.startsWith('anon') && !c.open && c.other);
      assert.ok(half.length >= 1);
      for (const c of half) c.other.other = null; // the guest vanishes without a word
      await run(25000);
      assert.ok(half.every((c) => c.other), 'still waiting at 25 s');
      await run(6000);
      assert.ok(half.every((c) => !c.other), 'half-open host connections closed');
      Z.s.close();
      w.pj.dialMs = 3;

      // the host goes away: the guest keeps trying; after a few tries the status
      // names the reason; "online" or retryNow() skips the backoff wait
      H.s.close();
      await waitFor(() => J.log.conn.at(-1) === 'reconnecting', 25000);
      await run(40000);
      assert.equal(J.log.conn.at(-1), 'reconnecting');
      assert.ok(J.log.status.some((x) => /No room with the code .* Still trying/.test(x)), J.log.status.join(' | '));
      assert.equal(J.log.errors.length, 0, 'never fatal once in');
      const H2 = mk(w, { mode: 'online', name: 'Hana', create: true, code: H.s.code }, pjOnly);
      await waitFor(() => H2.log.conn.at(-1) === 'open', 3000);
      const online = winL.filter(([e]) => e === 'online');
      assert.ok(online.length >= 1, 'listens for "online"');
      for (const [, f] of online) f();
      await waitFor(() => J.log.conn.at(-1) === 'open', 3000);
      assert.equal(J.log.conn.at(-1), 'open', 'rejoined without waiting for the backoff');
      assert.equal(J.s.retryNow(), false, 'nothing to retry when connected');
      H2.s.close(); J.s.close();
      await run(50);
    });
  } finally {
    Date.now = clock.now;
    for (const k of wrapped) delete subtle[k];
    clock.runAll(() => false, 5000);
    clock.uninstall();
    Date.now = realNow;
    for (const k of Object.keys(saved)) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k];
    }
  }
  return n;
}
