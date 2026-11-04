// Tests for js/room.js with a fake env and a manual clock.
import assert from 'node:assert/strict';
import { installFakeClock } from './fakeclock.js';
import { createRoom, PROTO, MIN_PROTO, ANIMAL_COUNT } from '../js/room.js';

export function runRoomTests() {
  const clock = installFakeClock();
  let n = 0;
  const t = (name, fn) => {
    try { fn(); n++; } catch (e) { e.message = `room: ${name}: ${e.message}`; throw e; }
  };

  // fake env: records sent messages per connection
  const mk = (extra = {}) => {
    const out = {}; const closedIds = [];
    const env = {
      send: (id, m) => { (out[id] = out[id] || []).push(JSON.parse(JSON.stringify(m))); },
      close: (id) => { closedIds.push(id); },
      now: clock.now,
      botDelay: 0,
      ...extra,
    };
    const room = createRoom(env);
    const last = (id, type) => { const l = (out[id] || []).filter((m) => !type || m.t === type); return l[l.length - 1]; };
    const join = (id, name, cid, hostOk = false, host = hostOk) => {
      room.open(id, { hostOk });
      room.message(id, { t: 'hello', name, cid, ver: PROTO, host });
      clock.drain();
    };
    const msg = (id, m) => { room.message(id, m); clock.drain(); };
    return { room, env, out, closedIds, last, join, msg };
  };

  t('host rule and lobby', () => {
    const r = mk();
    r.join('a', 'Alice', 'cid-a', true);
    r.join('b', '  Bob with a very long name indeed  ', 'cid-b', false, true); // not hostOk: host flag ignored
    r.join('c', 'Carol', 'cid-c', true); // hostOk but a host is connected: regular player
    const la = r.last('a', 'lobby').lobby;
    assert.equal(la.isHost, true);
    assert.equal(la.max, 4);
    assert.deepEqual(la.settings, { length: 1 });
    assert.deepEqual(la.members.map((m) => [m.name, m.host, m.you, m.connected]), [
      ['Alice', true, true, true], ['Bob with a very', false, false, true], ['Carol', false, false, true]]);
    assert.equal(r.last('b', 'lobby').lobby.isHost, false);
    assert.equal(r.last('c', 'lobby').lobby.isHost, false);
    assert.equal(r.last('c', 'lobby').lobby.members[2].you, true);
    // host leaves in the lobby: removed; a hostOk client may now claim host
    r.room.closed('a');
    clock.drain();
    assert.equal(r.last('b', 'lobby').lobby.members.length, 2);
    // same cid regains host on rejoin
    r.join('a2', 'Alice', 'cid-a', true);
    assert.equal(r.last('a2', 'lobby').lobby.isHost, true);
    assert.equal(r.last('c', 'lobby').lobby.isHost, false);
    r.room.destroy();
  });

  t('non-host lobby-cmd is a non-fatal error; settings', () => {
    const r = mk();
    r.join('a', 'A', 'ca', true);
    r.join('b', 'B', 'cb');
    r.msg('b', { t: 'lobby-cmd', cmd: 'start' });
    const e = r.last('b', 'error');
    assert.equal(e.fatal, false);
    assert.ok(!r.last('b', 'view'));
    r.msg('a', { t: 'lobby-cmd', cmd: 'settings', settings: { length: 2 } });
    assert.equal(r.last('b', 'lobby').lobby.settings.length, 2);
    r.msg('a', { t: 'lobby-cmd', cmd: 'settings', settings: { length: 99 } });
    assert.equal(r.last('b', 'lobby').lobby.settings.length, 2);
    r.room.destroy();
  });

  t('start fills bots, views carry isHost, acts work', () => {
    const r = mk({ botDelay: 50 });
    r.join('a', 'A', 'ca', true);
    r.join('b', 'B', 'cb');
    r.msg('a', { t: 'lobby-cmd', cmd: 'start' });
    const va = r.last('a', 'view').view, vb = r.last('b', 'view').view;
    assert.equal(va.isHost, true);
    assert.equal(vb.isHost, false);
    assert.equal(va.players.filter((p) => p.kind === 'bot').length, 2);
    assert.deepEqual(va.players.filter((p) => p.kind === 'human').map((p) => p.name).sort(), ['A', 'B']);
    // play: humans discard whatever they can, pass on claims, ready at end
    let steps = 0;
    const act = (id) => {
      const v = r.last(id, 'view').view;
      if (v.options && v.options.discard.length && v.turn === v.seat) r.msg(id, { t: 'act', a: { type: 'discard', tile: v.options.discard[0] } });
      else if (v.claim) r.msg(id, { t: 'act', a: { type: 'pass' } });
      else if (v.phase === 'end' && !v.ready.includes(v.seat)) r.msg(id, { t: 'act', a: { type: 'ready' } });
    };
    while (steps++ < 3000 && r.last('a', 'view').view.phase !== 'over') { act('a'); act('b'); clock.advance(100); r.msg('a', { t: 'ping', n: steps }); r.msg('b', { t: 'ping', n: steps }); }
    assert.ok(r.last('a', 'view').view.wall < 70 || r.last('a', 'view').view.round > 0 || r.last('a', 'view').view.kyoku > 0, 'game progressed');
    assert.equal(r.last('a', 'pong').t, 'pong');
    r.room.destroy();
    assert.equal(clock.pending(), 0, 'destroy clears timers');
  });

  t('rejoin restores seat; timeout -> bot; new cid takes bot seat', () => {
    const r = mk({ botDelay: 100000 }); // bots never move during this test
    r.join('a', 'A', 'ca', true);
    r.join('b', 'B', 'cb');
    r.msg('a', { t: 'lobby-cmd', cmd: 'start' });
    const seatB = r.last('b', 'view').view.seat;
    // reconnect with a new connection, same cid
    r.room.closed('b');
    clock.drain();
    assert.equal(r.last('a', 'view').view.players[seatB].kind, 'bot');
    r.join('b2', 'B', 'cb');
    assert.equal(r.last('b2', 'view').view.seat, seatB);
    assert.equal(r.last('a', 'view').view.players[seatB].kind, 'human');
    // duplicate tab: newest connection wins; the old one is told why (so it
    // stops instead of reconnecting and kicking the new one), then closed
    r.join('b3', 'B', 'cb');
    const kicked = r.last('b2', 'error');
    assert.equal(kicked.fatal, true);
    assert.equal(kicked.code, 'replaced');
    assert.equal(r.last('b3', 'view').view.seat, seatB);
    r.msg('b2', { t: 'act', a: { type: 'pass' } }); // ignored, no throw
    clock.advance(300);
    assert.ok(r.closedIds.includes('b2'));
    assert.equal(r.last('a', 'view').view.players[seatB].kind, 'human', 'closing the old tab keeps the seat human');
    // silence for >9 s -> closed, bot takes over (a keeps pinging)
    for (let i = 0; i < 11; i++) { r.msg('a', { t: 'ping', n: i }); clock.advance(1000); }
    assert.ok(r.closedIds.includes('b3'));
    assert.ok(!r.closedIds.includes('a'));
    assert.equal(r.last('a', 'view').view.players[seatB].kind, 'bot');
    // a stranger joins mid-game: takes a bot seat
    r.join('d', 'Dave', 'cd');
    const vd = r.last('d', 'view').view;
    assert.equal(vd.players[vd.seat].name, 'Dave');
    assert.equal(vd.players[vd.seat].kind, 'human');
    assert.equal(vd.isHost, false);
    // two more strangers fill the rest, the next one is refused
    r.join('e', 'E', 'ce'); r.join('f', 'F', 'cf');
    r.join('g', 'G', 'cg');
    assert.equal(r.last('g', 'error').fatal, true);
    clock.advance(300);
    assert.ok(r.closedIds.includes('g'));
    // back to lobby keeps connected members only (B timed out and was replaced)
    r.msg('d', { t: 'lobby-cmd', cmd: 'lobby' });
    assert.equal(r.last('d', 'error').fatal, false);
    r.msg('a', { t: 'lobby-cmd', cmd: 'lobby' });
    const l = r.last('a', 'lobby').lobby;
    assert.deepEqual(l.members.map((m) => m.name).sort(), ['A', 'Dave', 'E', 'F']);
    assert.ok(l.isHost);
    r.room.destroy();
  });

  t('version mismatch and full room are fatal', () => {
    const r = mk();
    r.room.open('x', { hostOk: false });
    r.msg('x', { t: 'hello', name: 'X', cid: 'cx', ver: PROTO + 1 });
    assert.equal(r.last('x', 'error').fatal, true);
    assert.ok(/older minimaj/i.test(r.last('x', 'error').msg), 'newer client: the host must update');
    assert.equal(r.last('x', 'error').code, 'version');
    r.room.open('y', { hostOk: false });
    r.msg('y', { t: 'hello', name: 'Y', cid: 'cy', ver: MIN_PROTO - 1 });
    assert.ok(/reload/i.test(r.last('y', 'error').msg) && /update|latest/i.test(r.last('y', 'error').msg), 'older client: reload or update the app');
    r.room.open('z', { hostOk: false });
    r.msg('z', { t: 'hello', name: 'Z', cid: 'cz' });
    assert.equal(r.last('z', 'error').fatal, true, 'no version at all');
    clock.advance(299);
    assert.ok(!r.closedIds.includes('x'));
    clock.advance(1);
    assert.ok(r.closedIds.includes('x'));
    for (const k of '1234') r.join('p' + k, 'P' + k, 'c' + k);
    r.join('p5', 'P5', 'c5');
    assert.equal(r.last('p5', 'error').fatal, true);
    assert.ok(/full/i.test(r.last('p5', 'error').msg));
    assert.equal(r.last('p1', 'lobby').lobby.members.length, 4);
    r.room.destroy();
  });

  t('another tab of the host\'s browser cannot take the host\'s seat', () => {
    const r = mk();
    r.join('self', 'Hostie', 'same-cid', true);
    r.join('p1', 'Hostie', 'same-cid', false); // joined the own room via the link in a 2nd tab
    assert.equal(r.last('p1', 'error').code, 'duplicate');
    assert.ok(!r.last('self', 'error'), 'host tab untouched');
    clock.advance(300);
    assert.ok(r.closedIds.includes('p1') && !r.closedIds.includes('self'));
    assert.equal(r.last('self', 'lobby').lobby.members.length, 1);
    assert.equal(r.last('self', 'lobby').lobby.isHost, true);
    // the host's own reconnect (hostOk) still replaces its old connection
    r.join('self2', 'Hostie', 'same-cid', true);
    assert.equal(r.last('self2', 'lobby').lobby.isHost, true);
    assert.equal(r.last('self', 'error').code, 'replaced');
    r.room.destroy();
  });

  t('junk messages never throw; rate limit', () => {
    const r = mk();
    for (const m of [null, 1, 'x', [], {}, { t: 5 }, { t: 'act' }, { t: 'act', a: 'x' }, { t: 'lobby-cmd' }, { t: 'hello' }, { t: 'hello', ver: PROTO, cid: {}, name: { x: 1 } }]) {
      r.room.message('j', m);
    }
    r.room.message('unknown', { t: 'ping', n: 1 });
    r.room.closed('nope');
    clock.drain();
    for (let i = 0; i < 200; i++) r.room.message('z', { t: 'ping', n: i });
    assert.ok(r.out.z.length <= 60 && r.out.z.length >= 30);
    r.room.destroy();
    r.room.message('a', { t: 'ping', n: 1 });
  });

  t('views are batched per microtask', () => {
    const sent = [];
    const r = mk({ botDelay: 100000, send: (id, m) => sent.push([id, m.t]) });
    r.join('a', 'A', 'ca', true);
    r.msg('a', { t: 'lobby-cmd', cmd: 'start' });
    sent.length = 0;
    for (let i = 0; i < 3; i++) r.room.message('a', { t: 'lobby-cmd', cmd: 'settings', settings: { length: 2 } });
    assert.equal(sent.length, 0);
    clock.drain();
    assert.deepEqual(sent, [['a', 'view']]);
    r.room.destroy();
  });

  t('play again restarts a finished game with the same people', () => {
    const r = mk();
    r.join('a', 'Alice', 'ca', true);
    r.join('b', 'Bob', 'cb');
    r.msg('a', { t: 'lobby-cmd', cmd: 'again' }); // no game yet: ignored
    assert.ok(!r.last('a', 'view'));
    r.msg('a', { t: 'lobby-cmd', cmd: 'start' });
    let steps = 0;
    const act = (id) => {
      const v = r.last(id, 'view').view;
      if (v.options && v.options.discard.length && v.turn === v.seat) r.msg(id, { t: 'act', a: { type: 'discard', tile: v.options.discard[0] } });
      else if (v.claim) r.msg(id, { t: 'act', a: { type: 'pass' } });
      else if (v.phase === 'end' && !v.ready.includes(v.seat)) r.msg(id, { t: 'act', a: { type: 'ready' } });
    };
    while (steps++ < 4000 && r.last('a', 'view').view.phase !== 'over') { act('a'); act('b'); clock.advance(50); r.msg('a', { t: 'ping', n: steps }); r.msg('b', { t: 'ping', n: steps }); }
    assert.equal(r.last('a', 'view').view.phase, 'over');
    r.msg('b', { t: 'lobby-cmd', cmd: 'again' }); // non-host refused
    assert.equal(r.last('b', 'view').view.phase, 'over');
    r.msg('a', { t: 'lobby-cmd', cmd: 'again' });
    const va = r.last('a', 'view').view, vb = r.last('b', 'view').view;
    assert.notEqual(va.phase, 'over');
    assert.equal(va.players.filter((p) => p.kind === 'human').length, 2);
    assert.ok(va.players.every((p) => p.score === 25000) && vb.phase === va.phase);
    r.room.destroy();
  });

  t('first dealer (seat 0) is random, computers included', () => {
    const dealers = { human: 0, bot: 0 };
    for (let i = 0; i < 60; i++) {
      const r = mk({ botDelay: 100000 });
      r.join('a', 'A', 'ca', true);
      r.msg('a', { t: 'lobby-cmd', cmd: 'start' });
      const v = r.last('a', 'view').view;
      dealers[v.players[0].kind]++;
      r.room.destroy();
    }
    // 1 human + 3 computers: the human should be oya about 1 time in 4
    assert.ok(dealers.human > 0 && dealers.bot > 0, JSON.stringify(dealers));
  });

  t('empty table returns to lobby after 60s', () => {
    const r = mk({ botDelay: 100000 });
    r.join('a', 'A', 'ca', true);
    r.msg('a', { t: 'lobby-cmd', cmd: 'start' });
    assert.ok(r.last('a', 'view'));
    r.room.closed('a');
    clock.drain();
    for (let i = 0; i < 30; i++) clock.advance(1000);
    r.join('a2', 'A', 'ca', true); // back within the grace period: still in the game
    assert.ok(r.last('a2', 'view'), 'rejoined running game');
    r.room.closed('a2');
    clock.drain();
    for (let i = 0; i < 63; i++) clock.advance(1000);
    r.join('a3', 'A', 'ca', true);
    assert.ok(r.last('a3', 'lobby') && !r.last('a3', 'view'), 'game ended, lobby shown');
    r.room.destroy();
  });

  t('every seat gets a distinct animal, the same on every screen', () => {
    for (let k = 0; k < 20; k++) {
      const r = mk({ botDelay: 100000 });
      r.join('a', 'A', 'ca', true);
      r.join('b', 'B', 'cb');
      r.msg('a', { t: 'lobby-cmd', cmd: 'start' });
      const va = r.last('a', 'view').view, vb = r.last('b', 'view').view;
      const an = va.players.map((p) => p.animal);
      assert.equal(an.length, 4);
      assert.ok(an.every((x) => Number.isInteger(x) && x >= 0 && x < ANIMAL_COUNT), `animal ids ${an}`);
      assert.equal(new Set(an).size, 4, `distinct ${an}`);
      assert.deepEqual(vb.players.map((p) => p.animal), an, 'same assignment for every seat');
      r.room.destroy();
    }
  });

  clock.uninstall();
  return n;
}
