import assert from 'node:assert/strict';
import {
  evaluateWin, shanten, shantenStd, shantenChiitoi, shantenKokushi, waitsOf, forEachImprovingTile,
} from '../js/hand.js';
import { countsOfTypes } from '../js/tiles.js';
import { Game } from '../js/game.js';
import { shantenStdRef } from './shanten-ref.js';
import { installFakeClock } from './fakeclock.js';
import { runRoomTests } from './room.test.js';
import { runQrTests } from './qr.test.js';
import { runNetTests } from './net.test.js';

// helpers: parse "123m456p789s11z" style (z: 1-7 = E S W N Wh G R) into tile ids
function parse(str) {
  const ids = []; const used = {};
  for (const grp of str.match(/\d+[mpsz]/g)) {
    const suit = grp.at(-1);
    for (const ch of grp.slice(0, -1)) {
      const n = +ch;
      const t = suit === 'z' ? 26 + n : 'mps'.indexOf(suit) * 9 + (n === 0 ? 4 : n - 1);
      if (n === 0) { ids.push(t * 4); continue; } // 0 = red five
      used[t] = (used[t] || 0) + 1;
      ids.push(t * 4 + (t === 4 || t === 13 || t === 22 ? used[t] : used[t] - 1));
    }
  }
  return ids;
}
const types = (ids) => ids.map((i) => i >> 2);
const sh = (s, open = 0) => shanten(countsOfTypes(types(parse(s))), open);

let n = 0;
const t = (name, fn) => { fn(); n++; };

t('shanten', () => {
  assert.equal(sh('123m456p789s1122z'), 0);
  assert.equal(sh('123m456p789s11222z'), -1);
  assert.equal(sh('19m19p19s1234567z'), 0);
  assert.equal(sh('1133557799m1122z'), -1);
  assert.deepEqual(waitsOf(countsOfTypes(types(parse('1112345678999m'))), 0), [0,1,2,3,4,5,6,7,8]);
});

const base = { melds: [], seatWind: 28, roundWind: 27, dora: [], ura: [] };
const ev = (hand, win, extra = {}) => {
  const ids = parse(hand);
  const w = parse(win)[0];
  const h = ids.concat([w + (ids.includes(w) ? 1 : 0)]);
  return evaluateWin({ ...base, hand: h, winTile: h.at(-1), ...extra });
};

t('pinfu riichi tsumo', () => {
  const r = ev('234m567p23488s67s', '8s', { tsumo: true, riichi: true });
  const names = r.yaku.map((y) => y[0]);
  assert.ok(names.includes('Pinfu') && names.includes('Riichi') && names.includes('Menzen Tsumo') && names.includes('Tanyao'), names);
  assert.equal(r.fu, 20);
  assert.equal(r.han, 4);
});

t('no yaku open', () => {
  const ids = parse('234m567p88s67s');
  const melds = [{ type: 'chi', tiles: parse('123p') }];
  const w = parse('8s')[0] + 2;
  assert.equal(evaluateWin({ ...base, hand: ids.concat([w]), melds, winTile: w }), null);
});

t('yakuhai + honitsu', () => {
  const r = ev('123456789m5551z', '1z', {});
  assert.ok(r, 'win');
  const names = r.yaku.map((y) => y[0]);
  assert.ok(names.includes('Honitsu') && names.includes('Ittsu') && names.includes('Hatsu') === false && names.includes('Haku'), names);
});

t('chiitoi', () => {
  const r = ev('1155m2299p3377s4z', '4z', { tsumo: true });
  assert.equal(r.fu, 25);
  assert.ok(r.yaku.some((y) => y[0] === 'Chiitoitsu'));
});

t('kokushi', () => {
  const r = ev('19m19p19s1234567z', '1m', {});
  assert.equal(r.yakuman, 1);
  assert.equal(r.base, 8000);
});

t('mangan', () => {
  const r = ev('22334455m667788p', '2m', { riichi: true, tsumo: true });
  assert.ok(r.han >= 5, JSON.stringify(r.yaku));
});

t('optimized shanten matches the reference implementation', () => {
  let tenpaiSeen = 0;
  let x = 987654321;
  const rng = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const add = (c, tt, k) => { if (c[tt] + k > 4) return false; c[tt] += k; return true; };
  for (let n = 0; n < 8000; n++) {
    const c = new Array(34).fill(0);
    const open = Math.floor(rng() * 5);
    let size = 14 - 3 * open - (rng() < 0.5 ? 1 : 0);
    const lim = rng() < 0.3 ? 9 : rng() < 0.5 ? 27 : 34; // bias towards one suit / no honors
    if (n % 2) {
      // near-complete hands: random sets + pair, then drop one or two tiles
      size = 14 - 3 * open;
      let k = 0;
      while (k < size - 2) {
        const tt = Math.floor(rng() * lim);
        if (rng() < 0.5 && tt < 27 && tt % 9 <= 6) {
          if (c[tt] < 4 && c[tt + 1] < 4 && c[tt + 2] < 4) { c[tt]++; c[tt + 1]++; c[tt + 2]++; k += 3; }
        } else if (add(c, tt, 3)) k += 3;
      }
      while (!add(c, Math.floor(rng() * lim), 2));
      for (let d = rng() < 0.6 ? 1 : 2; d > 0;) {
        const tt = Math.floor(rng() * 34);
        if (c[tt]) { c[tt]--; d--; size--; }
      }
    } else {
      for (let k = 0; k < size;) { const tt = Math.floor(rng() * lim); if (c[tt] < 4) { c[tt]++; k++; } }
    }
    assert.equal(shantenStd(c, open), shantenStdRef(c, open), c.join('') + ' open ' + open);
    if (n % 3) continue;
    // waits and improving tiles against brute force with the reference shanten
    const ref = (cc) => Math.min(shantenStdRef(cc, open), open ? 99 : Math.min(shantenChiitoi(cc), shantenKokushi(cc)));
    const sh0 = ref(c);
    assert.equal(shanten(c, open), sh0);
    const brute = [], wait = [];
    for (let u = 0; u < 34; u++) {
      if (c[u] >= 4) continue;
      c[u]++; const s1 = ref(c); c[u]--;
      if (s1 < sh0) brute.push(u);
      if (s1 === -1) wait.push(u);
    }
    const got = [];
    forEachImprovingTile(c, open, sh0, (u) => got.push(u));
    assert.deepEqual(got, brute, 'improving ' + c.join(''));
    if (size % 3 === 1) { assert.deepEqual(waitsOf(c, open), wait, 'waits ' + c.join('')); if (wait.length) tenpaiSeen++; }
  }
  console.log('  shanten cross-check: tenpai hands', tenpaiSeen);
  assert.ok(tenpaiSeen > 200, 'tenpai hands tested: ' + tenpaiSeen);
});

n += runQrTests();
n += runRoomTests();
n += await runNetTests();

// full bot games (on a fake clock: same results as real timers, no idle time)
const clock = installFakeClock();
const runGame = (seed, length) => {
  let s = seed;
  const rng = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  let done = null;
  const g = new Game([0, 1, 2, 3].map((i) => ({ name: 'B' + i, kind: 'bot' })), { length, botDelay: 0, rng,
    onChange: (gg) => {
      for (let i = 0; i < 4; i++) JSON.stringify(gg.view(i));
      const total = gg.players.reduce((a, p) => a + p.score, 0) + gg.sticks * 1000;
      if (total !== 100000) throw new Error('score sum ' + total);
      if (gg.phase === 'over') done = gg;
    } });
  g.start();
  clock.runAll(() => done);
  assert.ok(done, 'game finished');
  return done;
};

const t0 = Date.now();
const stats = { ron: 0, tsumo: 0, draw: 0, rounds: 0 };
for (let i = 1; i <= 30; i++) {
  const g = runGame(i * 7919, 2);
  for (const r of g.log) { stats[r.type]++; stats.rounds++; }
}
clock.uninstall();
console.log('bot games ok', stats, (Date.now() - t0) + 'ms');
// baseline from the original implementation (same seeds)
assert.deepEqual(stats, { ron: 197, tsumo: 96, draw: 24, rounds: 317 });
console.log(n, 'unit tests passed');
