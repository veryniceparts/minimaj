// Peer-to-peer session layer (PeerJS / WebRTC data channels).
// The host's browser runs the authoritative Game; clients send actions and
// receive their own seat's view. Nothing but signaling touches a server.
import { Game } from './game.js';

const PREFIX = 'minimaj-v1-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const makeCode = () => Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
export const normCode = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

const BOT_NAMES = ['CPU Ume', 'CPU Take', 'CPU Matsu'];

function clientId() {
  try {
    let id = localStorage.getItem('minimaj-cid');
    if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('minimaj-cid', id); }
    return id;
  } catch { return Math.random().toString(36).slice(2); }
}

function peerErrorText(err) {
  switch (err && err.type) {
    case 'peer-unavailable': return 'Room not found. Check the code — the host must keep their tab open.';
    case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
      return 'Could not reach the signaling server. Check your connection and try again.';
    case 'browser-incompatible': return 'This browser does not support WebRTC.';
    default: return (err && err.message) || 'Connection error';
  }
}

/* ------------------------------------------------------------------ */

export class HostSession {
  constructor(name, ui) {
    this.ui = ui; // { onLobby(lobby), onView(view), onError(msg), onStatus(msg) }
    this.name = name;
    this.cid = clientId();
    this.members = [{ cid: this.cid, name, conn: null, host: true }];
    this.settings = { length: 1 };
    this.game = null;
    this.seats = null; // seat -> member (or null for bot)
    this.flushQueued = false;
    this.open(0);
  }

  open(attempt) {
    this.code = makeCode();
    this.peer = new Peer(PREFIX + this.code);
    this.peer.on('open', () => this.pushLobby());
    this.peer.on('connection', (conn) => this.onConnection(conn));
    this.peer.on('disconnected', () => { try { this.peer.reconnect(); } catch { /* ignore */ } });
    this.peer.on('error', (err) => {
      if (err.type === 'unavailable-id' && attempt < 5) { this.peer.destroy(); this.open(attempt + 1); return; }
      if (err.type === 'peer-unavailable') return;
      this.ui.onError(peerErrorText(err));
    });
  }

  onConnection(conn) {
    conn.on('data', (msg) => this.onMessage(conn, msg));
    conn.on('close', () => this.onClose(conn));
    conn.on('error', () => this.onClose(conn));
  }

  send(conn, msg) { try { if (conn && conn.open) conn.send(msg); } catch { /* ignore */ } }

  onMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') return this.onHello(conn, msg);
    const m = this.members.find((x) => x.conn === conn);
    if (!m) return;
    if (msg.t === 'act' && this.game) {
      const seat = this.seatOf(m);
      if (seat >= 0) this.game.act(seat, msg.a);
    }
  }

  onHello(conn, msg) {
    const name = String(msg.name || 'Player').slice(0, 16);
    const cid = String(msg.cid || conn.peer);
    let m = this.members.find((x) => x.cid === cid && !x.host);
    if (m) {
      // reconnect
      if (m.conn && m.conn !== conn) try { m.conn.close(); } catch { /* ignore */ }
      m.conn = conn; m.name = name; m.gone = false;
    } else if (!this.game) {
      if (this.members.length >= 4) { this.send(conn, { t: 'error', msg: 'Room is full.' }); setTimeout(() => conn.close(), 500); return; }
      m = { cid, name, conn };
      this.members.push(m);
    } else {
      // join a running game: take over a computer seat
      const seat = this.seats.findIndex((x) => !x || x.gone);
      if (seat < 0) { this.send(conn, { t: 'error', msg: 'Game is full.' }); setTimeout(() => conn.close(), 500); return; }
      const old = this.seats[seat];
      if (old) this.members.splice(this.members.indexOf(old), 1);
      m = { cid, name, conn };
      this.members.push(m);
      this.seats[seat] = m;
    }
    this.ui.onStatus(`${name} joined`);
    if (this.game) {
      const seat = this.seatOf(m);
      this.game.setKind(seat, 'human', name);
    } else this.pushLobby();
  }

  onClose(conn) {
    const m = this.members.find((x) => x.conn === conn);
    if (!m) return;
    m.conn = null;
    if (!this.game) {
      this.members.splice(this.members.indexOf(m), 1);
      this.pushLobby();
    } else {
      m.gone = true;
      const seat = this.seatOf(m);
      if (seat >= 0) this.game.setKind(seat, 'bot');
    }
    this.ui.onStatus(`${m.name} left${this.game ? ' — a computer took over' : ''}`);
  }

  seatOf(m) { return this.seats ? this.seats.indexOf(m) : -1; }

  lobbyState() {
    return {
      code: this.code,
      host: true,
      members: this.members.map((m) => ({ name: m.name, host: !!m.host })),
      settings: this.settings,
    };
  }

  pushLobby() {
    const l = this.lobbyState();
    this.ui.onLobby(l);
    for (const m of this.members) if (m.conn) this.send(m.conn, { t: 'lobby', lobby: { ...l, host: false } });
  }

  setSettings(s) { Object.assign(this.settings, s); this.pushLobby(); }

  start() {
    const order = this.members.slice().sort(() => Math.random() - 0.5);
    this.seats = [0, 1, 2, 3].map((i) => order[i] || null);
    let b = 0;
    const players = this.seats.map((m) => (m ? { name: m.name, kind: 'human' } : { name: BOT_NAMES[b++], kind: 'bot' }));
    this.game = new Game(players, { length: this.settings.length, onChange: () => this.queueFlush() });
    this.game.start();
  }

  backToLobby() {
    this.game = null;
    this.seats = null;
    this.members = this.members.filter((m) => m.host || (m.conn && !m.gone));
    this.pushLobby();
  }

  queueFlush() {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      if (!this.game) return;
      this.seats.forEach((m, seat) => {
        if (!m) return;
        if (m.host) this.ui.onView(this.game.view(seat));
        else if (m.conn) this.send(m.conn, { t: 'view', view: this.game.view(seat) });
      });
    });
  }

  act(a) {
    if (!this.game) return;
    const seat = this.seatOf(this.members[0]);
    this.game.act(seat, a);
  }

  close() { try { this.peer.destroy(); } catch { /* ignore */ } }
}

/* ------------------------------------------------------------------ */

export class ClientSession {
  constructor(name, code, ui) {
    this.ui = ui; // { onLobby, onView, onError, onStatus, onLost }
    this.name = name;
    this.code = normCode(code);
    this.cid = clientId();
    this.connect();
  }

  connect() {
    this.closed = false;
    this.peer = new Peer();
    this.peer.on('open', () => {
      this.conn = this.peer.connect(PREFIX + this.code, { reliable: true, serialization: 'json' });
      const timer = setTimeout(() => { if (!this.conn.open) this.ui.onError('Could not connect to the host (timed out). They may be behind a strict firewall.'); }, 15000);
      this.conn.on('open', () => {
        clearTimeout(timer);
        this.conn.send({ t: 'hello', name: this.name, cid: this.cid });
      });
      this.conn.on('data', (msg) => {
        if (!msg) return;
        if (msg.t === 'lobby') this.ui.onLobby(msg.lobby);
        else if (msg.t === 'view') this.ui.onView(msg.view);
        else if (msg.t === 'error') { this.closed = true; this.ui.onError(msg.msg); }
      });
      this.conn.on('close', () => { if (!this.closed) this.ui.onLost(); });
    });
    this.peer.on('error', (err) => this.ui.onError(peerErrorText(err)));
  }

  reconnect() { this.close(); this.connect(); }
  act(a) { if (this.conn && this.conn.open) this.conn.send({ t: 'act', a }); }
  close() { this.closed = true; try { this.peer.destroy(); } catch { /* ignore */ } }
}
