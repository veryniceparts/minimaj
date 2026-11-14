// Room: lobby, seats, rejoin and bot takeover around one authoritative Game.
// Transport-agnostic: runs in the Go server (goja) and in a browser tab
// (online mode). Uses only setTimeout/clearTimeout/queueMicrotask and env:
//   env = { send(connId, msgObj), close(connId), now(): ms, log?(...a), botDelay?: ms }
import { Game } from './game.js';

// Protocol version. Bump PROTO when the messages change incompatibly; raise
// MIN_PROTO only when this room can no longer talk to older clients. Friends
// often run different builds (an old app vs. the newest web page), so the
// room accepts any client in [MIN_PROTO, PROTO] and says who must update.
export const PROTO = 2;
export const MIN_PROTO = 2;

const MAX = 4;
const BOT_NAMES = ['CPU Ume', 'CPU Take', 'CPU Matsu'];
export const ANIMAL_COUNT = 35; // mascots in js/animals.js (keep in sync: test checks)

// n distinct random animal indices (one per seat), so every screen shows the same ones
export function pickAnimals(n) {
  const a = [];
  for (let i = 0; i < ANIMAL_COUNT; i++) a.push(i);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (ANIMAL_COUNT - i));
    const x = a[i]; a[i] = a[j]; a[j] = x;
  }
  return a.slice(0, n);
}

// one random animal index not in `taken` (array of indices); -1 if none is free
export function pickAnimalExcept(taken) {
  const free = [];
  for (let i = 0; i < ANIMAL_COUNT; i++) if (taken.indexOf(i) < 0) free.push(i);
  return free.length ? free[Math.floor(Math.random() * free.length)] : -1;
}
export const MAX_REROLLS = 3; // per member per lobby visit (reset when a game ends)
const REMEMBER_MAX = 32; // lobby leavers whose mascot is kept for a rejoin (same cid)
const TIMEOUT_MS = 9000;
const CHECK_MS = 1000;
// a human the table has waited on this long falls asleep (their mascot only; nobody
// plays for them). Any action, emote or touch wakes them.
export const SLEEP_MS = 45000;
const RATE_WINDOW_MS = 1000;
const RATE_MAX = 60; // messages per window per connection; extra ones are dropped

// Mascot emotes (a tap or swipe on your own mascot), shown to everyone at the table.
// 'think-right' stays for older clients; a swipe right now sends 'angry'
export const EMOTES = ['go', 'hurray', 'sad', 'think-left', 'think-right', 'angry'];
export const EMOTE_GAP_MS = 1200; // at most one emote per member per 1.2 s ...
export const EMOTE_BURST = 10; // ... and 10 per 20 s; extra ones are dropped silently
export const EMOTE_BURST_MS = 20000;

// times: the member's recent emote timestamps (oldest first; trimmed in place).
// true (and records now) when one more emote is allowed. Clients use the same rule
// (with some slack for network jitter) so their own optimistic emote matches what
// the others see.
export function emoteAllowed(times, now, slack = 0) {
  while (times.length && now - times[0] >= EMOTE_BURST_MS + slack) times.shift();
  if (times.length && now - times[times.length - 1] < EMOTE_GAP_MS + slack) return false;
  if (times.length >= EMOTE_BURST) return false;
  times.push(now);
  return true;
}

function cleanName(s) {
  const n = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16).trim();
  return n || 'Player';
}

export function createRoom(env) {
  const log = (...a) => { try { if (env.log) env.log(...a); } catch (e) { /* ignore */ } };
  const conns = new Map(); // connId -> { meta, last, winStart, count, member }
  let members = []; // { cid, name, connId|null, gone, animal, rerolls (used) }
  const remembered = new Map(); // cid -> { animal, rerolls } of members who left the lobby
  let hostCid = null;
  const settings = { length: 1 };
  let game = null;
  let seats = null; // seat -> member | null (bot)
  // votes to let the computer play a disconnected friend's seat: seat -> Set of voter cids
  let votes = new Map();
  let waitSince = [null, null, null, null]; // when the table started waiting on each seat
  let destroyed = false;
  let flushQueued = false;
  let lobbyDirty = false;
  let viewDirty = false;
  let emoteN = 0; // id of the last emote broadcast (clients dedupe with it)
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

  // Send a fatal error, then close a moment later so the message gets out first.
  // code lets clients tell the reasons apart (e.g. 'version', 'replaced', 'full').
  function fatal(connId, msg, code) {
    send(connId, { t: 'error', msg, fatal: true, code: code || 'fatal' });
    const c = conns.get(connId);
    if (c) c.fatal = true;
    setTimeout(() => { if (conns.has(connId)) { closeConn(connId); onClosed(connId); } }, 300);
  }

  function versionError(ver) {
    const v = typeof ver === 'number' ? ver : 0;
    if (v < MIN_PROTO) {
      return 'Your minimaj is older than the host\'s. Reload the page — or, in the minimaj app, install the latest version — then join again.';
    }
    return 'The host is running an older minimaj. Ask them to reload their page or update their minimaj app, then join again.';
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
      members: members.map((m) => ({ name: m.name, host: isHost(m), you: m === me, connected: m.connId != null, animal: m.animal })),
      rerollsLeft: me ? Math.max(0, MAX_REROLLS - (me.rerolls || 0)) : 0,
      maxRerolls: MAX_REROLLS,
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
          v.votes = votesFor(m);
          send(m.connId, { t: 'view', view: v });
        });
      } else if (doLobby || doView) {
        for (const m of members) if (m.connId != null) send(m.connId, { t: 'lobby', lobby: lobbyFor(m) });
      }
    } catch (e) { log('flush failed', e); }
  }

  /* ---------------- membership ---------------- */

  // keep a leaver's mascot (and used rerolls) in case the same client comes back
  function remember(m) {
    remembered.delete(m.cid);
    remembered.set(m.cid, { animal: m.animal, rerolls: m.rerolls || 0 });
    if (remembered.size > REMEMBER_MAX) remembered.delete(remembered.keys().next().value);
  }

  function detach(m) {
    // member lost its connection
    m.connId = null;
    if (!game) {
      members = members.filter((x) => x !== m);
      remember(m);
      markLobby();
    } else {
      // keep the seat: the table waits for them to come back, unless the others vote
      // for the computer to play it (onVote)
      m.gone = true;
      const seat = seatOf(m);
      if (seat >= 0) { votes.delete(seat); game.setKind(seat, 'human', null, 'gone'); }
      recountVotes();
      markView();
    }
    log(`${m.name} left`);
  }

  function onHello(connId, c, msg) {
    if (!(typeof msg.ver === 'number' && msg.ver >= MIN_PROTO && msg.ver <= PROTO)) { fatal(connId, versionError(msg.ver), 'version'); return; }
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
        if (oc && oc.meta.hostOk && !(c.meta && c.meta.hostOk)) {
          // Another tab of the host's own browser (same client id) tries to
          // join as a guest: replacing the host's own connection would make
          // the two tabs kick each other forever.
          fatal(connId, 'This table is already open in another tab of this browser. Use that tab, or join from another browser or device.', 'duplicate');
          return;
        }
        // Tell the old connection why it is closed, so it stops instead of
        // reconnecting and kicking this one in turn (two tabs, same browser).
        if (oc) {
          oc.member = null;
          fatal(oldId, 'You joined this table from another tab or window, so this one was disconnected.', 'replaced');
        } else closeConn(oldId);
      }
      m.connId = connId; m.name = name; m.gone = false;
    } else if (!game) {
      if (members.length >= MAX) { fatal(connId, 'Room is full.', 'full'); return; }
      m = { cid, name, connId, gone: false, animal: -1, rerolls: 0 };
      const taken = members.map((x) => x.animal);
      const prev = remembered.get(cid);
      remembered.delete(cid);
      if (prev && Number.isInteger(prev.animal) && prev.animal >= 0 && taken.indexOf(prev.animal) < 0) {
        m.animal = prev.animal;
        m.rerolls = prev.rerolls;
      } else {
        m.animal = pickAnimalExcept(taken);
        if (prev) m.rerolls = prev.rerolls;
      }
      members.push(m);
    } else {
      // join a running game: take over a computer seat (a disconnected friend's seat
      // only once the others let the computer play it; never the host's, so they can come back)
      const seat = seats.findIndex((x, i) => !x || (x.gone && game.isBot(i) && x.cid !== hostCid));
      if (seat < 0) { fatal(connId, 'Game is full.', 'full'); return; }
      const old = seats[seat];
      if (old) members = members.filter((x) => x !== old);
      // keep the computer's mascot: it is already on everyone's table
      m = { cid, name, connId, gone: false, animal: game.players[seat].animal, rerolls: 0 };
      members.push(m);
      seats[seat] = m;
    }
    c.member = m;
    if (wantsHost && (hostCid == null || !hostConnected() || hostCid === cid)) hostCid = cid;
    log(`${name} joined`);
    if (game) {
      const seat = seatOf(m);
      if (seat >= 0) { votes.delete(seat); waitSince[seat] = null; game.setKind(seat, 'human', name); }
      recountVotes();
      markView();
    }
    markLobby();
  }

  function onLobbyCmd(connId, c, msg) {
    const m = c.member;
    if (!m) return;
    if (msg.cmd === 'reroll') { reroll(connId, m); return; }
    if (!isHost(m)) { send(connId, { t: 'error', msg: 'Only the host can do that.', fatal: false }); return; }
    if (msg.cmd === 'settings') {
      const s = msg.settings;
      if (s && typeof s === 'object' && (s.length === 1 || s.length === 2)) settings.length = s.length;
      markLobby();
    } else if (msg.cmd === 'start') {
      if (!game) startGame();
    } else if (msg.cmd === 'lobby') {
      // only from a game: in the lobby it would hand everyone a fresh set of rerolls
      if (game) backToLobby();
    } else if (msg.cmd === 'again') {
      // "Play again" on the final standings: same people, fresh seats/dealer.
      if (game && game.phase === 'over') { backToLobby(); startGame(); }
    }
  }

  // a new random mascot for one lobby member (any member, not only the host)
  function reroll(connId, m) {
    if (game) { send(connId, { t: 'error', msg: 'You can change your mascot in the lobby only.', fatal: false }); return; }
    if ((m.rerolls || 0) >= MAX_REROLLS) { send(connId, { t: 'error', msg: 'No rerolls left', fatal: false }); return; }
    const taken = members.map((x) => x.animal);
    if (m.animal >= 0) taken.push(m.animal);
    const a = pickAnimalExcept(taken);
    if (a < 0) return;
    m.animal = a;
    m.rerolls = (m.rerolls || 0) + 1;
    markLobby();
  }

  function startGame() {
    // Shuffle all four seats, empty ones (computers) included, so the first
    // dealer (seat 0, East / oya) is random — not always a human.
    const order = members.slice(0, 4);
    while (order.length < 4) order.push(null);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const x = order[i]; order[i] = order[j]; order[j] = x;
    }
    seats = [0, 1, 2, 3].map((i) => order[i] || null);
    let b = 0;
    // humans keep the mascot they had in the lobby; computers get free ones
    const taken = [];
    for (const m of seats) {
      if (!m) continue;
      if (!(Number.isInteger(m.animal) && m.animal >= 0 && m.animal < ANIMAL_COUNT) || taken.indexOf(m.animal) >= 0) m.animal = pickAnimalExcept(taken);
      taken.push(m.animal);
    }
    const animals = seats.map((m) => {
      if (m) return m.animal;
      const a = pickAnimalExcept(taken);
      taken.push(a);
      return a;
    });
    const players = seats.map((m, i) => ({ ...(m ? { name: m.name, kind: 'human' } : { name: BOT_NAMES[b++], kind: 'bot' }), animal: animals[i] }));
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
    votes = new Map();
    waitSince = [null, null, null, null];
  }

  function backToLobby() {
    stopGame();
    // a fresh set of rerolls after each game (for those who dropped out too)
    for (const r of remembered.values()) r.rerolls = 0;
    for (const m of members) { m.gone = false; m.rerolls = 0; if (m.connId == null) remember(m); }
    members = members.filter((m) => m.connId != null);
    markLobby();
  }

  function onClosed(connId) {
    const c = conns.get(connId);
    if (!c) return;
    conns.delete(connId);
    if (c.member && c.member.connId === connId) detach(c.member);
  }

  /* ---------------- emotes ---------------- */

  // {t:'emote', e}: in a game it goes to everyone as {t:'emote', seat, e, n}; in the
  // lobby as {t:'emote', seat: -1, member: index in lobby.members, e, n}.
  function onEmote(c, msg) {
    const m = c.member;
    if (!m || m.connId == null || EMOTES.indexOf(msg.e) < 0) return;
    const seat = game ? seatOf(m) : -1;
    const member = game ? -1 : members.indexOf(m);
    if (game ? seat < 0 : member < 0) return;
    if (!m.emotes) m.emotes = [];
    if (!emoteAllowed(m.emotes, env.now())) return;
    const out = { t: 'emote', seat, e: msg.e, n: ++emoteN };
    if (!game) out.member = member;
    for (const x of members) if (x.connId != null) send(x.connId, out);
  }

  /* ---------------- disconnected friends: wait, or vote for the computer ---------------- */

  // the friends still playing: they decide (a majority) whether the computer takes a seat
  const voters = () => (seats || []).filter((x) => x && !x.gone && x.connId != null);
  const votesNeeded = () => Math.floor(voters().length / 2) + 1;
  // per view: the seats waiting for a vote, how many voted, how many are needed, and yours
  function votesFor(me) {
    const out = [];
    if (!game) return out;
    seats.forEach((x, s) => {
      if (!x || !game.isGone(s)) return;
      const set = votes.get(s);
      out.push({ seat: s, n: set ? set.size : 0, need: votesNeeded(), mine: !!(set && me && set.has(me.cid)) });
    });
    return out;
  }
  // after someone leaves or comes back: drop votes from those who left; enough votes: the computer plays
  function recountVotes() {
    if (!game) return;
    const live = new Set(voters().map((x) => x.cid));
    for (const [s, set] of [...votes]) {
      for (const cid of [...set]) if (!live.has(cid)) set.delete(cid);
      if (!game.isGone(s)) votes.delete(s);
      else if (set.size && set.size >= votesNeeded()) { votes.delete(s); log(`computer plays seat ${s}`); game.setKind(s, 'bot', null, 'gone'); }
    }
  }
  // {t:'vote-cpu', seat}: let the computer play a disconnected friend's seat
  function onVote(c, msg) {
    const m = c.member;
    if (!game || !m || m.connId == null || m.gone || seatOf(m) < 0) return;
    const s = msg.seat;
    if (!Number.isInteger(s) || s < 0 || s > 3 || !game.isGone(s)) return;
    if (!votes.has(s)) votes.set(s, new Set());
    votes.get(s).add(m.cid);
    recountVotes();
    markView();
  }

  /* ---------------- asleep: the table waited on someone for SLEEP_MS ---------------- */

  function checkSleep(now) {
    if (!game) return;
    const w = game.waitingOn();
    for (let s = 0; s < 4; s++) {
      if (w.indexOf(s) < 0) { waitSince[s] = null; continue; }
      if (waitSince[s] == null) waitSince[s] = now;
      else if (now - waitSince[s] >= SLEEP_MS) game.setSleep(s, true);
    }
  }
  // the member did something: wake their mascot and restart the wait
  function wake(m) {
    if (!game || !m) return;
    const s = seatOf(m);
    if (s < 0) return;
    waitSince[s] = null;
    if (game.players[s].sleep) game.setSleep(s, false);
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
      checkSleep(now);
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
              wake(c.member);
              const seat = seatOf(c.member);
              if (seat >= 0 && msg.a && typeof msg.a === 'object') game.act(seat, msg.a);
            }
            break;
          case 'lobby-cmd': onLobbyCmd(connId, c, msg); break;
          case 'emote': wake(c.member); onEmote(c, msg); break;
          case 'wake': wake(c.member); break;
          case 'vote-cpu': onVote(c, msg); break;
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
