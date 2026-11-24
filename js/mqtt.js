// A minimal MQTT 3.1.1 client over WebSocket (subprotocol 'mqtt', binary
// frames). Online rooms use public MQTT brokers only to pass connection
// offers between players (js/rendezvous.js), so this does just enough:
// clean sessions, QoS 0 publish/subscribe, keepalive pings, and reconnecting
// with backoff (topics are subscribed again after each reconnect).
// No dependencies; browser only (not part of the native server's bundle).

const CONNECT = 1, CONNACK = 2, PUBLISH = 3, PUBACK = 4, SUBSCRIBE = 8, SUBACK = 9;
const UNSUBSCRIBE = 10, UNSUBACK = 11, PINGREQ = 12, PINGRESP = 13, DISCONNECT = 14;
const MAX_LEN = 268435455; // the largest remaining length MQTT can express
const RETRY_MS = [1000, 2000, 5000, 10000, 20000, 30000];
const CONNECT_TIMEOUT_MS = 10000;
const REFRESH_WAIT_MS = 5000; // refresh(): a ping unanswered this long = dead socket

const enc = new TextEncoder();
const dec = new TextDecoder();

// Remaining length: 7 bits per byte, low bits first, high bit = more follows.
export function encodeLength(n) {
  if (!(n >= 0 && n <= MAX_LEN)) throw new Error('mqtt: packet too large');
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 128;
    out.push(b);
  } while (n > 0);
  return out;
}

const u16 = (n) => [(n >> 8) & 255, n & 255];
const str = (s) => { const b = enc.encode(s); return [...u16(b.length), ...b]; };

function packet(type, flags, body) {
  const head = [(type << 4) | flags, ...encodeLength(body.length)];
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

export function connectPacket(clientId, keepalive) {
  // protocol name "MQTT", level 4 (3.1.1), flags: clean session only
  return packet(CONNECT, 0, [...str('MQTT'), 4, 0x02, ...u16(keepalive), ...str(clientId)]);
}
export function subscribePacket(id, topics) {
  const body = [...u16(id)];
  for (const t of topics) body.push(...str(t), 0); // requested QoS 0
  return packet(SUBSCRIBE, 2, body);
}
export function unsubscribePacket(id, topics) {
  const body = [...u16(id)];
  for (const t of topics) body.push(...str(t));
  return packet(UNSUBSCRIBE, 2, body);
}
export function publishPacket(topic, payload) {
  const p = typeof payload === 'string' ? enc.encode(payload) : payload;
  const t = str(topic);
  const body = new Uint8Array(t.length + p.length);
  body.set(t, 0);
  body.set(p, t.length);
  return packet(PUBLISH, 0, body); // QoS 0, not retained
}
export const pingPacket = () => packet(PINGREQ, 0, []);
export const disconnectPacket = () => packet(DISCONNECT, 0, []);

// PUBLISH body -> { topic, payload (string), qos, id }
export function parsePublish(flags, body) {
  const tl = (body[0] << 8) | body[1];
  const topic = dec.decode(body.subarray(2, 2 + tl));
  const qos = (flags >> 1) & 3;
  let i = 2 + tl;
  let id = 0;
  if (qos > 0) { id = (body[i] << 8) | body[i + 1]; i += 2; }
  return { topic, payload: dec.decode(body.subarray(i)), qos, id };
}

// Splits a byte stream into packets: a frame may hold several packets, and a
// packet may arrive split over several frames. onPacket(type, flags, body).
export function createParser(onPacket) {
  let buf = new Uint8Array(0);
  return {
    push(chunk) {
      if (!chunk || !chunk.length) return;
      const nb = new Uint8Array(buf.length + chunk.length);
      nb.set(buf, 0);
      nb.set(chunk, buf.length);
      buf = nb;
      for (;;) {
        if (buf.length < 2) return;
        let len = 0, mul = 1, i = 1;
        for (;;) {
          if (i >= buf.length) return; // the length itself is not complete yet
          const b = buf[i++];
          len += (b & 127) * mul;
          if (!(b & 128)) break;
          mul *= 128;
          if (i > 4) throw new Error('mqtt: bad remaining length');
        }
        if (buf.length < i + len) return;
        const type = buf[0] >> 4, flags = buf[0] & 15;
        const body = buf.slice(i, i + len);
        buf = buf.slice(i + len);
        onPacket(type, flags, body);
      }
    },
  };
}

const randomId = () => 'mm' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 10);

// opts: { onStatus(connected: bool), keepalive (s), WebSocket (constructor) }
// Returns { subscribe(topic, fn(payloadString)), unsubscribe(topic),
//           publish(topic, string) -> bool (false: not connected, dropped),
//           close(), connected, url }.
export function mqttConnect(url, opts = {}) {
  const WS = opts.WebSocket || globalThis.WebSocket;
  const keepalive = opts.keepalive || 30;
  const subs = new Map(); // topic -> fn
  let ws = null;
  let connected = false;
  let closed = false;
  let retry = 0;
  let retryTimer = null;
  let pingTimer = null;
  let connTimer = null;
  let lastRx = 0;
  let nextId = 1;

  const pid = () => { const id = nextId; nextId = nextId % 65535 + 1; return id; };
  const setConnected = (v) => {
    if (v === connected) return;
    connected = v;
    try { if (opts.onStatus) opts.onStatus(v); } catch (e) { /* ignore */ }
  };
  const raw = (bytes) => { try { if (ws && ws.readyState === 1) { ws.send(bytes); return true; } } catch (e) { /* ignore */ } return false; };

  function open() {
    retryTimer = null;
    if (closed) return;
    let sock;
    try { sock = new WS(url, 'mqtt'); } catch (e) { scheduleRetry(); return; }
    ws = sock;
    try { sock.binaryType = 'arraybuffer'; } catch (e) { /* ignore */ }
    const parser = createParser((type, flags, body) => onPacket(sock, type, flags, body));
    sock.onopen = () => { if (ws === sock) raw(connectPacket(randomId(), keepalive)); };
    sock.onmessage = (e) => {
      if (ws !== sock) return;
      const d = e.data;
      const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null;
      if (!bytes) return;
      lastRx = Date.now();
      try { parser.push(bytes); } catch (err) { lost(sock); }
    };
    sock.onclose = () => lost(sock);
    sock.onerror = () => {};
    connTimer = setTimeout(() => { connTimer = null; if (ws === sock && !connected) lost(sock); }, CONNECT_TIMEOUT_MS);
  }

  function onPacket(sock, type, flags, body) {
    if (ws !== sock) return;
    if (type === CONNACK) {
      if (body[1] !== 0) { lost(sock); return; } // refused by the broker
      if (connTimer) { clearTimeout(connTimer); connTimer = null; }
      retry = 0;
      if (subs.size) raw(subscribePacket(pid(), [...subs.keys()]));
      setConnected(true);
      schedulePing();
    } else if (type === PUBLISH) {
      const m = parsePublish(flags, body);
      if (m.qos === 1) raw(packet(PUBACK, 0, u16(m.id)));
      const fn = subs.get(m.topic);
      if (fn) { try { fn(m.payload); } catch (e) { console.error('mqtt handler', e); } }
    }
    // SUBACK, UNSUBACK, PINGRESP: nothing to do (lastRx already updated)
  }

  // ping every keepalive/2; a broker that stays silent for 1.5 keepalives is gone
  function schedulePing() {
    if (pingTimer) clearTimeout(pingTimer);
    pingTimer = setTimeout(() => {
      pingTimer = null;
      if (!connected || closed) return;
      if (Date.now() - lastRx > keepalive * 1500) { lost(ws); return; }
      raw(pingPacket());
      schedulePing();
    }, keepalive * 500);
  }

  function lost(sock) {
    if (ws !== sock) return;
    ws = null;
    if (connTimer) { clearTimeout(connTimer); connTimer = null; }
    if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
    try { sock.onclose = sock.onmessage = sock.onopen = null; sock.close(); } catch (e) { /* ignore */ }
    setConnected(false);
    scheduleRetry();
  }

  function scheduleRetry() {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(open, RETRY_MS[Math.min(retry++, RETRY_MS.length - 1)]);
  }

  open();

  return {
    url,
    get connected() { return connected; },
    subscribe(topic, fn) {
      const had = subs.has(topic);
      subs.set(topic, fn);
      if (!had && connected) raw(subscribePacket(pid(), [topic]));
    },
    unsubscribe(topic) {
      if (!subs.delete(topic)) return;
      if (connected) raw(unsubscribePacket(pid(), [topic]));
    },
    publish(topic, payload) { return connected ? raw(publishPacket(topic, payload)) : false; },
    // Check the link now (the network changed, the tab is back from the
    // background): a socket can die without a close event, so ping and drop it
    // if nothing comes back soon; a reconnect that is waiting happens at once.
    refresh() {
      if (closed) return;
      if (!connected) {
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; retry = 0; open(); }
        return;
      }
      const sock = ws, at = Date.now();
      raw(pingPacket());
      setTimeout(() => { if (ws === sock && lastRx < at) { retry = 0; lost(sock); } }, REFRESH_WAIT_MS);
    },
    close() {
      if (closed) return;
      closed = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      const sock = ws;
      if (sock) {
        if (connected) raw(disconnectPacket());
        lost(sock); // clears timers; scheduleRetry is a no-op once closed
      }
      setConnected(false);
    },
  };
}
