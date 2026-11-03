import assert from 'node:assert/strict';
import { evaluateWin, shanten, waitsOf } from '../js/hand.js';
import { countsOfTypes } from '../js/tiles.js';
import { Game } from '../js/game.js';

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

// full bot games
const runGame = (seed, length) => new Promise((resolve, reject) => {
  let s = seed;
  const rng = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const g = new Game([0, 1, 2, 3].map((i) => ({ name: 'B' + i, kind: 'bot' })), { length, botDelay: 0, rng,
    onChange: (gg) => {
      for (let i = 0; i < 4; i++) JSON.stringify(gg.view(i));
      const total = gg.players.reduce((a, p) => a + p.score, 0) + gg.sticks * 1000;
      if (total !== 100000) reject(new Error('score sum ' + total));
      if (gg.phase === 'over') resolve(gg);
    } });
  g.start();
});

const t0 = Date.now();
const stats = { ron: 0, tsumo: 0, draw: 0, rounds: 0 };
const yakuCount = {};
for (let i = 1; i <= 30; i++) {
  const g = await runGame(i * 7919, 2);
  for (const r of g.log) { stats[r.type]++; stats.rounds++; }
}
console.log('bot games ok', stats, (Date.now() - t0) + 'ms');
console.log(n, 'unit tests passed');
