// Room: lobby, seats, rejoin and bot takeover around one authoritative Game.
// Transport-agnostic: runs in the Go server (goja) and in a browser tab
// (online mode). Uses only setTimeout/clearTimeout/queueMicrotask and env:
//   env = { send(connId, msgObj), close(connId), now(): ms, log?(...a), botDelay?: ms }
import { Game } from './game.js';

export const PROTO = 1;

const MAX = 4;
const BOT_NAMES = ['CPU Ume', 'CPU Take', 'CPU Matsu'];
const TIMEOUT_MS = 9000;
const CHECK_MS = 1000;
const RATE_WINDOW_MS = 1000;
const RATE_MAX = 60; // messages per window per connection; extra ones are dropped

function cleanName(s) {
  const n = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16).trim();
  return n || 'Player';
}

export function createRoom(env) {
  const log = (...a) => { try { if (env.log) env.log(...a); } catch (e) { /* ignore */ } };
  const conns = new Map(); // connId -> { meta, last, winStart, count, member }
  let members = []; // { cid, name, connId|null, gone }
  let hostCid = null;
  const settings = { length: 1 };
  let game = null;
  let seats = null; // seat -> member | null (bot)
  let destroyed = false;
  let flushQueued = false;
  let lobbyDirty = false;
  let viewDirty = false;
  let lastCheck = env.now();
  let checkTimer = setTimeout(check, CHECK_MS);

  const send = (connId, msg) => {
    if (connId == null || destroyed) return;
    try { env.send(connId, msg); } catch (e) { log('send failed', e); }
  };
  const closeConn = (connId) => { try { env.close(connId); } catch (e) { log('close failed', e); } };
  const isHost = (m) => !!m && m.cid === hostCid;
  const hostConnected = () => members.some((m) => isHost(m) && m.connId != null);
  const seatOf = (m) => (seats ? seats.indexOf(m) : -1);

  function fatal(connId, msg) {
    send(connId, { t: 'error', msg, fatal: true });
    const c = conns.get(connId);
    if (c) c.fatal = true;
    setTimeout(() => { if (conns.has(connId)) { closeConn(connId); onClosed(connId); } }, 300);
  }

  /* ---------------- batching ---------------- */

  function queueFlush() {
    if (flushQueued || destroyed) return;
    flushQueued = true;
    queueMicrotask(flush);
  }
  function markLobby() { lobbyDirty = true; queueFlush(); }
  function markView() { viewDirty = true; queueFlush(); }

  function lobbyFor(me) {
    return {
      members: members.map((m) => ({ name: m.name, host: isHost(m), you: m === me, connected: m.connId != null })),
      settings: { length: settings.length },
      isHost: isHost(me),
      max: MAX,
    };
  }

  function flush() {
    flushQueued = false;
    if (destroyed) return;
    const doLobby = lobbyDirty, doView = viewDirty;
    lobbyDirty = viewDirty = false;
    try {
      if (game) {
        if (!doView && !doLobby) return;
        seats.forEach((m, seat) => {
          if (!m || m.connId == null) return;
          const v = game.view(seat);
          v.isHost = isHost(m);
          send(m.connId, { t: 'view', view: v });
        });
      } else if (doLobby || doView) {
        for (const m of members) if (m.connId != null) send(m.connId, { t: 'lobby', lobby: lobbyFor(m) });
      }
    } catch (e) { log('flush failed', e); }
  }

  /* ---------------- membership ---------------- */

  function detach(m) {
    // member lost its connection
    m.connId = null;
    if (!game) {
      members = members.filter((x) => x !== m);
      markLobby();
    } else {
      m.gone = true;
      const seat = seatOf(m);
      if (seat >= 0) game.setKind(seat, 'bot');
      markView();
    }
    log(`${m.name} left`);
  }

  function onHello(connId, c, msg) {
    if (msg.ver !== PROTO) { fatal(connId, 'This page is out of date. Please reload.'); return; }
    const name = cleanName(msg.name);
    let cid = typeof msg.cid === 'string' || typeof msg.cid === 'number' ? String(msg.cid).slice(0, 64) : '';
    if (!cid) cid = 'conn:' + String(connId);
    const wantsHost = msg.host === true && !!(c.meta && c.meta.hostOk);

    // the connection said hello before as someone else: drop that binding first
    if (c.member && c.member.cid !== cid) { const old = c.member; c.member = null; detach(old); }

    let m = members.find((x) => x.cid === cid);
    if (m) {
      // rejoin (reconnect, reload, duplicate tab): the newest connection wins
      if (m.connId != null && m.connId !== connId) {
        const oldId = m.connId;
        const oc = conns.get(oldId);
        if (oc) { oc.member = null; conns.delete(oldId); }
        closeConn(oldId);
      }
      m.connId = connId; m.name = name; m.gone = false;
    } else if (!game) {
      if (members.length >= MAX) { fatal(connId, 'Room is full.'); return; }
      m = { cid, name, connId, gone: false };
      members.push(m);
    } else {
      // join a running game: take over a computer seat
      const seat = seats.findIndex((x) => !x || x.gone);
      if (seat < 0) { fatal(connId, 'Game is full.'); return; }
      const old = seats[seat];
      if (old) members = members.filter((x) => x !== old);
      m = { cid, name, connId, gone: false };
      members.push(m);
      seats[seat] = m;
    }
    c.member = m;
    if (wantsHost && (hostCid == null || !hostConnected() || hostCid === cid)) hostCid = cid;
    log(`${name} joined`);
    if (game) {
      const seat = seatOf(m);
      if (seat >= 0) game.setKind(seat, 'human', name);
      markView();
    }
    markLobby();
  }

  function onLobbyCmd(connId, c, msg) {
    const m = c.member;
    if (!m) return;
    if (!isHost(m)) { send(connId, { t: 'error', msg: 'Only the host can do that.', fatal: false }); return; }
    if (msg.cmd === 'settings') {
      const s = msg.settings;
      if (s && typeof s === 'object' && (s.length === 1 || s.length === 2)) settings.length = s.length;
      markLobby();
    } else if (msg.cmd === 'start') {
      if (!game) startGame();
    } else if (msg.cmd === 'lobby') {
      backToLobby();
    }
  }

  function startGame() {
    const order = members.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const x = order[i]; order[i] = order[j]; order[j] = x;
    }
    seats = [0, 1, 2, 3].map((i) => order[i] || null);
    let b = 0;
    const players = seats.map((m) => (m ? { name: m.name, kind: 'human' } : { name: BOT_NAMES[b++], kind: 'bot' }));
    const opts = { length: settings.length, onChange: () => markView() };
    if (env.botDelay != null) opts.botDelay = env.botDelay;
    game = new Game(players, opts);
    game.start();
  }

  function stopGame() {
    if (!game) return;
    game.stop();
    game = null;
    seats = null;
  }

  function backToLobby() {
    stopGame();
    members = members.filter((m) => m.connId != null);
    for (const m of members) m.gone = false;
    markLobby();
  }

  function onClosed(connId) {
    const c = conns.get(connId);
    if (!c) return;
    conns.delete(connId);
    if (c.member && c.member.connId === connId) detach(c.member);
  }

  /* ---------------- heartbeat ---------------- */

  const EMPTY_MS = 60000;
  let emptySince = null;

  function check() {
    checkTimer = null;
    if (destroyed) return;
    try {
      const now = env.now();
      if (now - lastCheck > 5 * CHECK_MS) {
        // this timer was starved (sleeping device, throttled tab): don't blame the peers
        for (const c of conns.values()) c.last = now;
      } else {
        for (const [id, c] of [...conns]) {
          if (now - c.last > TIMEOUT_MS) { log('timeout', id); closeConn(id); onClosed(id); }
        }
      }
      lastCheck = now;
      // nobody left at the table: stop the bots after a grace period (saves battery on a phone host)
      if (game && !members.some((m) => m.connId != null)) {
        if (emptySince == null) emptySince = now;
        else if (now - emptySince > EMPTY_MS) { log('table empty, back to lobby'); emptySince = null; backToLobby(); }
      } else emptySince = null;
    } catch (e) { log('check failed', e); }
    checkTimer = setTimeout(check, CHECK_MS);
  }

  /* ---------------- public API ---------------- */

  function open(connId, meta) {
    if (destroyed) return;
    const now = env.now();
    conns.set(connId, { meta: meta || {}, last: now, winStart: now, count: 0, member: null, fatal: false });
  }

  return {
    open,
    message(connId, msg) {
      if (destroyed) return;
      try {
        let c = conns.get(connId);
        if (!c) { open(connId, { hostOk: false }); c = conns.get(connId); }
        const now = env.now();
        c.last = now;
        if (now - c.winStart >= RATE_WINDOW_MS) { c.winStart = now; c.count = 0; }
        if (++c.count > RATE_MAX) return;
        if (c.fatal || !msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
        switch (msg.t) {
          case 'ping': send(connId, { t: 'pong', n: typeof msg.n === 'number' ? msg.n : 0 }); break;
          case 'hello': onHello(connId, c, msg); break;
          case 'act':
            if (game && c.member) {
              const seat = seatOf(c.member);
              if (seat >= 0 && msg.a && typeof msg.a === 'object') game.act(seat, msg.a);
            }
            break;
          case 'lobby-cmd': onLobbyCmd(connId, c, msg); break;
          default: break;
        }
      } catch (e) { log('message failed', e); }
    },
    closed(connId) {
      if (destroyed) return;
      try { onClosed(connId); } catch (e) { log('closed failed', e); }
    },
    // Public table summary for "tables nearby" (no private data).
    summary() {
      const host = members.find(isHost);
      return {
        host: host ? host.name : null,
        players: members.filter((m) => m.connId != null).length,
        playing: !!game,
      };
    },
    destroy() {
      destroyed = true;
      if (checkTimer != null) clearTimeout(checkTimer);
      checkTimer = null;
      stopGame();
      conns.clear();
      members = [];
    },
  };
}
