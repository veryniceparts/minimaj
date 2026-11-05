// Engine tests: scoring (yaku, fu, limits), rule scenarios on rigged walls, and
// many seeded bot games checking invariants. Run by test/run.js; also runnable
// alone: node test/engine.test.js
import assert from 'node:assert/strict';
import { evaluateWin, basePoints } from '../js/hand.js';
import { tileType, doraFromIndicator } from '../js/tiles.js';
import { Game } from '../js/game.js';
import { installFakeClock } from './fakeclock.js';

// "123m456p789s11z" (z: 1-7 = E S W N Wh G R; 0 = red five) -> tile ids, each id
// used once per call; ids from `taken` are skipped so several calls never collide
export function parse(str, taken = new Set()) {
  const ids = [];
  for (const grp of str.match(/\d+[mpsz]/g)) {
    const suit = grp.at(-1);
    for (const ch of grp.slice(0, -1)) {
      const n = +ch;
      const t = suit === 'z' ? 26 + n : 'mps'.indexOf(suit) * 9 + (n === 0 ? 4 : n - 1);
      const red = suit !== 'z' && n === 0;
      let id = -1;
      for (let k = 0; k < 4; k++) {
        const c = t * 4 + k;
        const isRedId = c === 16 || c === 52 || c === 88;
        if (taken.has(c) || isRedId !== red) continue;
        id = c; break;
      }
      if (id < 0) throw new Error('no tile left for ' + grp);
      taken.add(id);
      ids.push(id);
    }
  }
  return ids;
}

const names = (r) => r.yaku.map((y) => y[0]);
const hanOf = (r, n) => (r.yaku.find((y) => y[0] === n) || [])[1];

// evaluate "hand" + winning tile; melds: [[type, '123m'], ...]
function ev(hand, win, extra = {}) {
  const taken = new Set();
  const melds = (extra.melds || []).map(([type, s]) => ({ type, tiles: parse(s, taken) }));
  const ids = parse(hand, taken);
  const w = parse(win, taken)[0];
  return evaluateWin({
    seatWind: 28, roundWind: 27, dora: [], ura: [], ...extra, melds, hand: ids.concat([w]), winTile: w,
  });
}

function scoringTests(t) {
  t('fu: closed kan of a terminal/honor is 32, tanki 2, closed ron 10', () => {
    const r = ev('123m456p789s5s', '5s', { riichi: true, melds: [['ankan', '4444z']] });
    assert.equal(r.fu, 70); // 20 + 10 + 32 + 2 = 64 -> 70
    assert.equal(r.han, 1);
  });
  t('fu: open pon / open kan / yakuhai pon', () => {
    // open: 20 + open kan of 2m (8) + pon of haku (4) + tsumo 2 = 34 -> 40
    const r = ev('567p88s56s', '7s', { tsumo: true, melds: [['minkan', '2222m'], ['pon', '555z']] });
    assert.equal(r.fu, 40);
    assert.deepEqual(names(r), ['Haku']);
  });
  t('fu: open pinfu shape is 30 by ron and tsumo', () => {
    let r = ev('567p345s88s67s', '5s', { melds: [['chi', '234m']] });
    assert.equal(r.fu, 30);
    assert.deepEqual(names(r), ['Tanyao']);
    assert.equal(basePoints(r.han, r.fu, 0) * 4, 960);
    r = ev('567p345s88s67s', '5s', { tsumo: true, melds: [['chi', '234m']] });
    assert.equal(r.fu, 30);
  });
  t('fu: pinfu tsumo 20, pinfu ron 30', () => {
    let r = ev('234m567p23488s67s', '8s', { tsumo: true });
    assert.equal(r.fu, 20);
    assert.deepEqual(names(r).sort(), ['Menzen Tsumo', 'Pinfu', 'Tanyao']);
    r = ev('234m567p23488s67s', '8s', {});
    assert.equal(r.fu, 30);
  });
  t('ambiguous wait: the better interpretation (ryanmen/pinfu over kanchan)', () => {
    // 56678s + 7s: 567+678 (7 closes 56: ryanmen) or 678 with 68 (kanchan)
    let r = ev('234m789p11s56678s', '7s', {});
    assert.ok(r && names(r).includes('Pinfu'), JSON.stringify(r));
    assert.equal(r.fu, 30);
    r = ev('234m789p11s56678s', '7s', { tsumo: true, riichi: true });
    assert.equal(r.fu, 20);
    assert.equal(r.han, 3);
  });
  t('kanchan wait fu', () => {
    // 1113m + 2m = 11 + 123 (kanchan): 20 + 10 + 2 = 32 -> 40
    const r = ev('1113m456p789s567s', '2m', { riichi: true });
    assert.equal(r.fu, 40);
  });
  t('fu: double wind pair counts 4', () => {
    // dealer (East) in East round: 20 + 10 + 4 = 34 -> 40
    const r = ev('123m456p789s11z23s', '4s', { riichi: true, seatWind: 27 });
    assert.equal(r.fu, 40);
    assert.ok(!names(r).includes('Pinfu'));
  });
  t('chiitoitsu 25 fu, no rounding', () => {
    const r = ev('1155m2299p3377s4z', '4z', { riichi: true });
    assert.equal(r.fu, 25);
    assert.equal(r.han, 3);
    assert.equal(basePoints(3, 25, 0), 800);
  });
  t('sanankou + toitoi on shanpon ron (the ron triplet counts as open)', () => {
    const r = ev('111m222p333s55s77s', '7s', {});
    assert.equal(r.yakuman, 0);
    assert.deepEqual(names(r).sort(), ['Sanankou', 'Toitoi']);
    assert.equal(r.fu, 50); // 20 + 10 + 8 + 4 + 4 + 2 = 48
    const t2 = ev('111m222p333s55s77s', '7s', { tsumo: true });
    assert.equal(t2.yakuman, 1);
    assert.deepEqual(names(t2), ['Suuankou']);
    // tanki: four concealed triplets by ron is still suuankou
    assert.equal(ev('111m222p333s777s5s', '5s', {}).yakuman, 1);
  });
  t('open / closed han values', () => {
    assert.equal(hanOf(ev('123456789m5551z', '1z', {}), 'Honitsu'), 3);
    assert.equal(hanOf(ev('456789m555z1z', '1z', { melds: [['chi', '123m']] }), 'Honitsu'), 2);
    assert.equal(hanOf(ev('123345678m22m99m', '9m', {}), 'Chinitsu'), 6);
    assert.equal(hanOf(ev('456789m11m99m', '9m', { melds: [['chi', '123m']] }), 'Chinitsu'), 5);
    assert.equal(hanOf(ev('123m123p789s99s12s', '3s', {}), 'Junchan'), 3);
    assert.equal(hanOf(ev('123p789s99s12s', '3s', { melds: [['chi', '123m']] }), 'Junchan'), 2);
    assert.equal(hanOf(ev('123m123p789s11z12s', '3s', {}), 'Chanta'), 2);
    assert.equal(hanOf(ev('123p789s11z12s', '3s', { melds: [['chi', '123m']] }), 'Chanta'), 1);
    assert.equal(hanOf(ev('123m123p11s23s', '1s', { melds: [['chi', '123s']] }), 'Sanshoku Doujun'), 1);
    assert.equal(hanOf(ev('123m123p123s11s22s', '2s', {}), 'Sanshoku Doujun'), 2);
    assert.equal(hanOf(ev('123m456m11p78m', '9m', { melds: [['pon', '555z']] }), 'Ittsu'), 1);
    assert.equal(hanOf(ev('112233m445566p7s', '7s', {}), 'Ryanpeikou'), 3);
    assert.equal(hanOf(ev('112233m456p789s5s', '5s', {}), 'Iipeikou'), 1);
    assert.deepEqual(names(ev('123m123m555z4m', '4m', { melds: [['chi', '123s']] })), ['Haku']); // no open iipeikou
    assert.equal(hanOf(ev('555z666z77z123m44m', '4m', {}), 'Shousangen'), 2);
    assert.equal(hanOf(ev('111m999p11z99s', '9s', { melds: [['pon', '111s']] }), 'Honroutou'), 2);
    assert.equal(hanOf(ev('123m456p789s5s', '5s', { riichi: true, doubleRiichi: true }), 'Double Riichi'), 2);
  });
  t('yakuhai: seat, round, dragons, double wind', () => {
    const r = ev('111z123m456p789s5s', '5s', { seatWind: 27, roundWind: 27 });
    assert.deepEqual(names(r).sort(), ['Round Wind', 'Seat Wind']);
    assert.equal(r.han, 2);
    assert.equal(ev('222z123m456p789s5s', '5s', { seatWind: 29 }), null); // South is nobody's wind here
  });
  t('yakuman', () => {
    assert.deepEqual(names(ev('555z666z777z11m23m', '1m', {})), ['Daisangen']);
    assert.deepEqual(names(ev('111z222z333z44z23m', '1m', {})), ['Shousuushii']);
    assert.equal(ev('111z222z333z444z5z', '5z', {}).yakuman, 3); // daisuushii + tsuuiisou + suuankou
    assert.deepEqual(names(ev('22334466888s66z', '6z', { melds: [] })), ['Ryuuiisou']);
    assert.deepEqual(names(ev('1112345678999m', '5m', {})), ['Chuuren Poutou']);
    assert.ok(names(ev('111m999m111p99p11s', '1s', { melds: [] })).includes('Chinroutou'));
    assert.deepEqual(names(ev('19m19p19s1234567z', '1z', {})), ['Kokushi Musou']);
    const kans = [['minkan', '2222m'], ['minkan', '3333p'], ['ankan', '4444s'], ['minkan', '6666s']];
    assert.ok(names(ev('9m', '9m', { melds: kans })).includes('Suukantsu'));
    assert.equal(ev('9m', '9m', { melds: kans.slice(1).concat([['pon', '222m']]) }).yakuman, 0);
  });
  t('limits and point table', () => {
    assert.equal(basePoints(4, 30, 0), 1920); // no kiriage mangan
    assert.equal(basePoints(3, 70, 0), 2000);
    assert.equal(basePoints(5, 30, 0), 2000);
    assert.equal(basePoints(7, 30, 0), 3000);
    assert.equal(basePoints(10, 30, 0), 4000);
    assert.equal(basePoints(12, 30, 0), 6000);
    assert.equal(basePoints(13, 30, 0), 8000);
    assert.equal(basePoints(0, 0, 2), 16000);
    const r = ev('1112345678999p', '5p', { riichi: true, melds: [], dora: [3, 4, 5], tsumo: true });
    assert.equal(r.limit, 'Yakuman'); // chuuren; dora ignored
  });
  t('dora: indicator wraparound, red fives, ura only with riichi', () => {
    assert.equal(doraFromIndicator(8), 0);
    assert.equal(doraFromIndicator(26), 18);
    assert.equal(doraFromIndicator(30), 27);
    assert.equal(doraFromIndicator(33), 31);
    assert.equal(doraFromIndicator(31), 32);
    let r = ev('123m406p789s555s4z', '4z', { riichi: true, dora: [21], ura: [21] }); // 5s is dora
    assert.equal(hanOf(r, 'Dora'), 3);
    assert.equal(hanOf(r, 'Aka Dora'), 1);
    assert.equal(hanOf(r, 'Ura Dora'), 3);
    r = ev('123m406p789s55s11z', '1z', { dora: [21], ura: [21], seatWind: 27 }); // no riichi
    assert.equal(hanOf(r, 'Ura Dora'), undefined);
    assert.equal(ev('23m406p789s55s', '1m', { dora: [21], melds: [['chi', '123s']] }), null); // dora is no yaku
  });
  t('situational yaku', () => {
    const r = ev('123m456p11s23s', '4s', { tsumo: true, haitei: true, melds: [['ankan', '4444z']] });
    assert.deepEqual(names(r).sort(), ['Haitei Raoyue', 'Menzen Tsumo']);
    assert.deepEqual(names(ev('23m456p789s11s', '1m', { houtei: true, melds: [['chi', '123s']] })), ['Houtei Raoyui']);
    assert.deepEqual(names(ev('23m456p789s11s', '1m', { tsumo: true, rinshan: true, melds: [['chi', '123s']] })), ['Rinshan Kaihou']);
    assert.deepEqual(names(ev('23m456p789s11s', '1m', { chankan: true, melds: [['chi', '123s']] })), ['Chankan']);
    assert.deepEqual(names(ev('23m456p789s111s55z', '1m', { tsumo: true, tenhou: true })), ['Tenhou']);
  });
}

/* ------------------------------------------------------------------ */
/* Rigged game scenarios                                               */
/* ------------------------------------------------------------------ */

// A bot-free game with set hands. hands: 4 strings (13 tiles; the dealer seat
// may give 14). draws: tiles drawn in order after the deal (the first is the
// dealer's draw when its hand has 13). Everything else is filled randomly.
function rig({ hands, draws = '', dealer = 0, scores, honba = 0, sticks = 0, round = 0, length = 1, dead = '', melds = [] }) {
  const g = new Game([0, 1, 2, 3].map((i) => ({ name: 'P' + i, kind: 'human' })), { length, botDelay: 0 });
  g.kyoku = dealer; g.round = round; g.honba = honba; g.sticks = sticks;
  if (scores) scores.forEach((s, i) => { g.players[i].score = s; });
  g.startRound();
  const taken = new Set();
  const ms = [0, 1, 2, 3].map((i) => (melds[i] || []).map(([type, str]) => ({ type, tiles: parse(str, taken), from: (i + 3) % 4 })));
  const hs = hands.map((h) => parse(h, taken));
  const dr = draws ? parse(draws, taken) : [];
  const dw = dead ? parse(dead, taken) : [];
  const rest = [...Array(136).keys()].filter((id) => !taken.has(id));
  const deadWall = dw.concat(rest.splice(0, 14 - dw.length));
  // live wall is popped from the end: draws in order at the end
  const live = rest.concat(dr.slice().reverse());
  g.dead = deadWall;
  g.live = live;
  if (!dead) g.doraCount = 0; // no dora unless the test sets the dead wall
  g.players.forEach((p, i) => { p.hand = hs[i]; p.melds = ms[i]; p.drawn = null; });
  g.players.forEach((p) => g.updateWaits(p));
  const d = g.players[dealer];
  if (d.hand.length === 14) { d.drawn = d.hand[13]; g.turn = dealer; g.phase = 'discard'; } else g.drawTile(dealer, false);
  return g;
}
const id = (g, seat, s) => {
  const t = parse(s)[0] >> 2;
  const x = g.players[seat].hand.find((i) => i >> 2 === t);
  assert.ok(x != null, `seat ${seat} has no ${s}`);
  return x;
};
const act = (g, seat, a) => assert.ok(g.act(seat, a), `act ${seat} ${JSON.stringify(a)} in ${g.phase}`);
const discard = (g, seat, s, riichi = false) => act(g, seat, { type: 'discard', tile: id(g, seat, s), riichi });
const passAll = (g) => { if (g.phase === 'claim') for (const s of Object.keys(g.claim.opts)) act(g, +s, { type: 'pass' }); };
const total = (g) => g.players.reduce((a, p) => a + p.score, 0) + g.sticks * 1000;

// non-tenpai filler hands (13 tiles each, no pairs)
const FILL = ['147m258p369s1234z', '258m369p147s1235z', '369m147p258s1236z', '147m258p369s1237z'];
const SCORES_25 = [25000, 25000, 25000, 25000];
// discard the drawn tile, everyone passes
const tsumogiri = (g, seat) => {
  assert.equal(g.turn, seat);
  act(g, seat, { type: 'discard', tile: g.players[seat].drawn });
  passAll(g);
};
const yakuNames = (g) => g.result.yaku.map((y) => y[0]);

export const revealSeen = { play: 0, end: 0 };
const VIEW_KEYS = ['phase', 'seat', 'round', 'kyoku', 'honba', 'sticks', 'length', 'dealer', 'turn', 'wall', 'dora',
  'players', 'hand', 'drawn', 'options', 'mustDiscard', 'claim', 'claimTile', 'lastDiscard', 'waits', 'furiten',
  'riichiLocked', 'event', 'result', 'ready', 'final', 'revealed'].sort().join();
const PLAYER_KEYS = ['name', 'kind', 'score', 'animal', 'riichi', 'melds', 'discards', 'handCount'].sort().join();
// a seat's view must not contain other seats' concealed tiles, the wall or ura
// indicators while the hand is played
export function checkView(g, v, seat) {
  const json = JSON.stringify(v);
  for (const p of v.players) assert.equal(Object.keys(p).sort().join(), PLAYER_KEYS);
  if (v.phase === 'end' || v.phase === 'over') {
    // every hand is shown once the hand is over
    assert.equal(v.revealed.length, 4);
    v.revealed.forEach((h, s) => {
      const p = g.players[s];
      const all = [...h.hand, ...(h.drawn != null ? [h.drawn] : [])];
      assert.equal(v.players[s].handCount, all.length);
      assert.deepEqual(all.sort((a, b) => a - b), p.hand.slice().sort((a, b) => a - b));
    });
    revealSeen.end++;
    return json;
  }
  revealSeen.play++;
  assert.equal(v.revealed, null);
  assert.equal(v.result, null);
  const me = g.players[seat];
  assert.deepEqual([...v.hand, ...(v.drawn != null ? [v.drawn] : [])].sort((a, b) => a - b), me.hand.slice().sort((a, b) => a - b));
  if (v.drawn != null) assert.ok(g.turn === seat);
  assert.equal(Object.keys(v).sort().join(), VIEW_KEYS);
  const others = new Set(g.players.filter((q) => q.seat !== seat).flatMap((q) => q.hand));
  const mine = [...v.hand, v.drawn, ...(v.options ? v.options.discard.concat(v.options.riichi) : [])];
  assert.ok(!mine.some((x) => others.has(x)), 'other hands leak');
  if (v.claim) assert.ok(g.claim.opts[seat]);
  if (v.options) assert.equal(g.turn, seat);
  assert.equal(v.dora.length, g.doraCount);
  assert.equal(v.wall, g.live.length);
  return json;
}

function scenarioTests(t) {
  t('ron: non-dealer from dealer, honba 300 and riichi sticks', () => {
    const g = rig({ hands: ['5s147m258p369s127z', '234m567p234s88s67s', FILL[2], FILL[3]], draws: '9m', honba: 2, sticks: 1, scores: [25000, 25000, 25000, 24000] });
    discard(g, 0, '5s');
    assert.equal(g.phase, 'claim');
    assert.deepEqual(Object.keys(g.claim.opts), ['1']);
    act(g, 1, { type: 'ron' });
    assert.equal(g.result.type, 'ron');
    assert.equal(g.result.han, 2); assert.equal(g.result.fu, 30);
    assert.deepEqual(g.result.deltas, [-2600, 3600, 0, 0]);
    assert.equal(g.sticks, 0);
    assert.equal(total(g), 100000);
    assert.deepEqual(g.pendingNext, { round: 0, kyoku: 1, honba: 0 });
  });
  t('ron: dealer wins 6x, renchan with honba +1', () => {
    const g = rig({ dealer: 1, hands: [FILL[0], '234m567p234s88s67s', FILL[2], FILL[3]], draws: '9m9m9p5s' });
    tsumogiri(g, 1); tsumogiri(g, 2); tsumogiri(g, 3);
    act(g, 0, { type: 'discard', tile: g.players[0].drawn });
    act(g, 1, { type: 'ron' });
    assert.deepEqual(g.result.deltas, [-2900, 2900, 0, 0]);
    assert.deepEqual(g.pendingNext, { round: 0, kyoku: 1, honba: 1 });
  });
  t('tsumo: non-dealer split with honba 100 each; dealer pays double', () => {
    const g = rig({ hands: [FILL[0], '234m567p234s88s67s', FILL[2], FILL[3]], draws: '9m9m9p9p9s8s', honba: 1 });
    tsumogiri(g, 0); tsumogiri(g, 1); tsumogiri(g, 2); tsumogiri(g, 3); tsumogiri(g, 0); // no chiihou
    assert.equal(g.turn, 1);
    assert.ok(g.turnOptions(1).tsumo);
    act(g, 1, { type: 'tsumo' });
    assert.deepEqual(yakuNames(g).sort(), ['Menzen Tsumo', 'Pinfu', 'Tanyao']);
    assert.equal(g.result.fu, 20);
    assert.deepEqual(g.result.deltas, [-1400, 3000, -800, -800]); // 700/1300 + 100 each
    assert.equal(g.result.points, '700 / 1300');
  });
  t('tsumo: dealer all pay 2x', () => {
    const g = rig({ dealer: 1, hands: [FILL[0], '234m567p234s88s67s', FILL[2], FILL[3]], draws: '9m9m9p9p8s' });
    tsumogiri(g, 1); tsumogiri(g, 2); tsumogiri(g, 3); tsumogiri(g, 0);
    act(g, 1, { type: 'tsumo' });
    assert.deepEqual(g.result.deltas, [-1300, 3900, -1300, -1300]);
  });
  t('head bump: the first player after the discarder wins, no double ron', () => {
    const g = rig({ hands: ['5s147m258p369s127z', FILL[1], '234m567p234s88s67s', '234m567p234s88s67s'.replace('234m', '345m')], draws: '9m' });
    discard(g, 0, '5s');
    assert.deepEqual(Object.keys(g.claim.opts).sort(), ['2', '3']);
    act(g, 3, { type: 'ron' });
    assert.equal(g.phase, 'claim'); // seat 2 has priority and has not answered
    act(g, 2, { type: 'ron' });
    assert.equal(g.result.winner, 2);
    assert.equal(g.result.deltas[3], 0);
  });
  t('claims: ron beats pon, pon beats chi', () => {
    let g = rig({ hands: ['5s9s147m369p12345z', '55s1s8s258m147p467z', '234m567p234s88s67s', FILL[3]], draws: '9m' });
    discard(g, 0, '5s');
    assert.ok(g.claim.opts[1].pon && g.claim.opts[2].ron);
    act(g, 1, { type: 'pon' }); act(g, 2, { type: 'ron' });
    assert.equal(g.result.winner, 2);
    g = rig({ hands: ['5s9s147m369p12345z', '46s1s8s258m147p467z', '55s19s369m258p156z', FILL[3]], draws: '9m' });
    discard(g, 0, '5s');
    assert.ok(g.claim.opts[1].chi && g.claim.opts[2].pon);
    act(g, 1, { type: 'chi', tiles: [21, 23] }); act(g, 2, { type: 'pon' });
    assert.equal(g.turn, 2);
    assert.equal(g.players[2].melds[0].type, 'pon');
    assert.ok(g.mustDiscard && g.players[2].drawn == null);
    assert.ok(!g.turnOptions(2).discard.some((x) => tileType(x) === 22), 'kuikae: no 5s after pon of 5s');
  });
  t('chi only from the player on the left', () => {
    const g = rig({ hands: ['5s9s147m369p12345z', FILL[1], '46s1s8s258m147p467z', '46s1s8s258m147p467z'], draws: '9m' });
    discard(g, 0, '5s');
    assert.equal(g.claim, null); // seats 2 and 3 cannot chi
    assert.equal(g.turn, 1);
  });
  t('kuikae: chi forbidden when only swap-call tiles would remain', () => {
    const g = rig({ hands: ['3m147m258p369s127z', '4566m', FILL[2], FILL[3]], draws: '9m' });
    const p = g.players[1];
    p.melds = [{ type: 'pon', tiles: parse('111z') }, { type: 'pon', tiles: parse('222z') }, { type: 'pon', tiles: parse('333z') }];
    g.updateWaits(p);
    discard(g, 0, '3m');
    // 45m+3m leaves 66m (6m is the other end) -> no chi; 3m+? no other shape
    assert.ok(!g.claim || !g.claim.opts[1] || !g.claim.opts[1].chi, JSON.stringify(g.claim && g.claim.opts));
  });
  t('kuikae: after chi the called tile and the other end are not discardable', () => {
    const g = rig({ hands: ['3m147m258p369s127z', '45m36m258p369s137z', FILL[2], FILL[3]], draws: '9m' });
    discard(g, 0, '3m');
    act(g, 1, { type: 'chi', tiles: [3, 4] });
    const o = g.turnOptions(1);
    assert.ok(!o.discard.some((x) => tileType(x) === 2 || tileType(x) === 5));
    assert.ok(!g.act(1, { type: 'discard', tile: id(g, 1, '6m') }));
    assert.ok(g.act(1, { type: 'discard', tile: id(g, 1, '2p') }));
  });
  t('furiten: own discard blocks ron, tsumo still allowed', () => {
    const g = rig({ hands: ['5s147m258p369s127z', '234m567p234s88s67s', FILL[2], FILL[3]], draws: '9m' });
    g.players[1].discards.push({ tile: 103, riichi: false, tsumogiri: false, called: false });
    assert.ok(g.isFuriten(g.players[1]));
    discard(g, 0, '5s');
    assert.ok(!g.claim.opts[1].ron && g.claim.opts[1].chi);
    act(g, 1, { type: 'pass' });
    assert.equal(g.turn, 1);
  });
  t('furiten: temporary after passing, lifted by own discard; permanent in riichi', () => {
    const g = rig({ hands: ['5s147m258p369s127z', FILL[1], '234m567p234s88s67s', FILL[3]], draws: '9m8s' });
    discard(g, 0, '5s');
    act(g, 2, { type: 'pass' });
    const p2 = g.players[2];
    assert.ok(p2.furitenTemp && g.isFuriten(p2));
    act(g, 1, { type: 'discard', tile: g.players[1].drawn }); // 8s: seat 2 may not ron it
    assert.ok(g.claim.opts[2].pon && !g.claim.opts[2].ron);
    act(g, 2, { type: 'pass' });
    tsumogiri(g, 2);
    assert.ok(!g.isFuriten(p2));
    // riichi furiten
    const h = rig({ hands: ['5s147m258p369s127z', '234m567p234s88s67s', FILL[2], FILL[3]], draws: '9m' });
    h.players[1].riichi = true;
    discard(h, 0, '5s');
    act(h, 1, { type: 'pass' });
    assert.ok(h.players[1].furitenRiichi);
  });
  t('riichi: deposit, double riichi, ippatsu broken by a call', () => {
    const g = rig({ hands: ['234m567p234s88s6s9m', FILL[1], '11p258m369p47s136z', FILL[3]], draws: '7s1p', scores: SCORES_25 });
    const o = g.turnOptions(0);
    assert.deepEqual([...new Set(o.riichi.map(tileType))].sort((a, b) => a - b), [8, 25]); // 9m or 8s
    discard(g, 0, '9m', true);
    const p0 = g.players[0];
    assert.ok(p0.riichi && p0.ippatsu && p0.doubleRiichi);
    assert.equal(p0.score, 24000); assert.equal(g.sticks, 1);
    act(g, 1, { type: 'discard', tile: g.players[1].drawn }); // 1p: seat 2 may pon
    assert.equal(g.phase, 'claim');
    act(g, 2, { type: 'pon' });
    assert.ok(!p0.ippatsu, 'ippatsu broken by the pon');
    assert.equal(total(g), 100000);
  });
  t('riichi: no deposit when the riichi tile is ronned; needs 1000 points and 4 tiles', () => {
    let g = rig({ hands: ['234m567p234s88s6s9m', '234m78m567p234s99p', FILL[2], FILL[3]], draws: '7s' });
    discard(g, 0, '9m', true);
    act(g, 1, { type: 'ron' });
    assert.deepEqual(g.result.deltas, [-1000, 1000, 0, 0]);
    assert.equal(g.players[0].score, 24000);
    assert.equal(g.sticks, 0);
    assert.ok(!g.players[0].riichi);
    g = rig({ hands: ['234m567p234s88s6s9m', FILL[1], FILL[2], FILL[3]], draws: '7s', scores: [900, 25000, 25000, 25000] });
    assert.deepEqual(g.turnOptions(0).riichi, []);
    g = rig({ hands: ['234m567p234s88s6s9m', FILL[1], FILL[2], FILL[3]], draws: '7s' });
    g.live = g.live.slice(-3);
    assert.deepEqual(g.turnOptions(0).riichi, []);
    g.live = g.live.concat(g.dead.slice(0, 1)); // 4 tiles: allowed
    assert.equal(g.turnOptions(0).riichi.length > 0, true);
  });
  t('chankan on an added kan only', () => {
    let g = rig({ hands: [FILL[0], '234m567p234s88s67s', '5s147m369p123z', FILL[3]], melds: [[], [], [['pon', '055s']], []], draws: '9m9p9p' });
    tsumogiri(g, 0); tsumogiri(g, 1);
    assert.deepEqual(g.turnOptions(2).kakan, [22]);
    act(g, 2, { type: 'kakan', t: 22 });
    assert.equal(g.claim.kind, 'chankan');
    assert.deepEqual(g.claim.opts, { 1: { ron: true } });
    act(g, 1, { type: 'ron' });
    assert.ok(yakuNames(g).includes('Chankan'));
    assert.equal(g.kans, 0);
    // closed kan: no chankan, the kan dora turns at once, rinshan draw
    g = rig({ hands: [FILL[0], '234m567p234s88s67s', '0555s147m369p123z', FILL[3]], draws: '9m9p9p' });
    tsumogiri(g, 0); tsumogiri(g, 1);
    const live = g.live.length;
    act(g, 2, { type: 'ankan', t: 22 });
    assert.equal(g.phase, 'discard'); assert.equal(g.turn, 2);
    assert.ok(g.rinshan);
    assert.equal(g.doraCount, 1);
    assert.equal(g.live.length, live - 1); // the dead wall stays at 14
    assert.equal(g.players[2].hand.length, 11); // 14 - 4 + rinshan tile
  });
  t('open kan: kan dora turns after the discard; rinshan kaihou', () => {
    let g = rig({ hands: ['5s147m258p369s127z', FILL[1], '055s147m369p1234z', FILL[3]], draws: '9m' });
    discard(g, 0, '5s');
    assert.ok(g.claim.opts[2].kan && g.claim.opts[2].pon);
    act(g, 2, { type: 'kan' });
    assert.equal(g.turn, 2); assert.ok(g.rinshan);
    assert.equal(g.doraCount, 0); assert.equal(g.doraPending, 1);
    act(g, 2, { type: 'discard', tile: g.players[2].drawn });
    assert.equal(g.doraCount, 1);
    // rinshan kaihou after a closed kan
    g = rig({ hands: ['777z234m567p88s67s', FILL[1], FILL[2], FILL[0]], draws: '7z', dead: '1p2p3p4p6p7p8p9p1s2s8s' });
    assert.deepEqual(g.turnOptions(0).ankan, [33]);
    act(g, 0, { type: 'ankan', t: 33 });
    assert.ok(g.turnOptions(0).tsumo);
    act(g, 0, { type: 'tsumo' });
    assert.deepEqual(yakuNames(g).sort(), ['Chun', 'Menzen Tsumo', 'Rinshan Kaihou']);
    assert.equal(g.result.dora.length, 2);
  });
  t('last tile: no calls, houtei; haitei', () => {
    let g = rig({ hands: ['5s147m258p369s127z', '234m567p234s88s67s', '55s1m8m369p39s1234z', FILL[3]], draws: '9m' });
    g.live = [];
    discard(g, 0, '5s');
    assert.deepEqual(g.claim.opts, { 1: { ron: true } });
    act(g, 1, { type: 'ron' });
    assert.ok(yakuNames(g).includes('Houtei Raoyui'));
    g = rig({ hands: ['5s147m258p369s127z', '234m567p234s88s67s', FILL[2], FILL[3]], draws: '9m8s' });
    g.live = g.live.slice(-1);
    g.anyCall = true; // not a first-turn (chiihou) win
    act(g, 0, { type: 'discard', tile: g.players[0].drawn }); // seat 1 may chi 9m? no
    assert.equal(g.live.length, 0);
    act(g, 1, { type: 'tsumo' });
    assert.ok(yakuNames(g).includes('Haitei Raoyue'));
  });
  t('exhaustive draw: tenpai payments, karaten is noten, dealer rotation', () => {
    let g = rig({ hands: ['5s147m258p369s127z', '123p789p789s5m', '234m567p234s88s67s', FILL[3]], melds: [[], [['pon', '055m']], [], []], draws: '9m', honba: 1 });
    assert.deepEqual(g.players[1].waits, [], 'karaten: all four 5m are in hand and meld');
    g.live = [];
    tsumogiri(g, 0);
    assert.equal(g.result.type, 'draw');
    assert.deepEqual(g.result.tenpai, [2]);
    assert.deepEqual(g.result.deltas, [-1000, -1000, 3000, -1000]);
    assert.deepEqual(g.pendingNext, { round: 0, kyoku: 1, honba: 2 });
    g = rig({ hands: ['5s147m258p369s127z', '234m567p234s88s67s', '345m678p234s99p67s', FILL[3]], draws: '9m' });
    g.live = [];
    tsumogiri(g, 0);
    assert.deepEqual(g.result.deltas, [-1500, 1500, 1500, -1500]);
    g = rig({ hands: ['234m567p234s88s67s', FILL[1], FILL[2], FILL[3]], draws: '9m' });
    g.live = [];
    tsumogiri(g, 0);
    assert.deepEqual(g.result.deltas, [3000, -1000, -1000, -1000]);
    assert.deepEqual(g.pendingNext, { round: 0, kyoku: 0, honba: 1 }); // dealer tenpai: renchan
  });
  t('game end: all-last dealer win in first place, bust below zero, length', () => {
    const allLast = (scores) => {
      const g = rig({ dealer: 3, hands: [FILL[0], FILL[1], FILL[2], '234m567p234s88s67s'], draws: '9m5s', scores });
      tsumogiri(g, 3);
      act(g, 0, { type: 'discard', tile: g.players[0].drawn });
      act(g, 3, { type: 'ron' });
      return g;
    };
    let g = allLast(SCORES_25);
    assert.equal(g.result.gameOver, true);
    g = allLast([40000, 20000, 20000, 20000]);
    assert.equal(g.result.gameOver, false);
    assert.deepEqual(g.pendingNext, { round: 0, kyoku: 3, honba: 1 });
    g = rig({ hands: ['5s147m258p369s127z', '234m567p234s88s67s', FILL[2], FILL[3]], draws: '9m', scores: [1000, 33000, 33000, 33000] });
    discard(g, 0, '5s');
    act(g, 1, { type: 'ron' });
    assert.equal(g.result.gameOver, true);
    for (const s of [0, 1, 2, 3]) act(g, s, { type: 'ready' });
    assert.equal(g.phase, 'over');
    assert.equal(g.final[3].seat, 0);
    // last hand of the game, non-dealer wins: game over
    g = rig({ dealer: 3, hands: ['5s147m258p369s127z', '234m567p234s88s67s', FILL[2], FILL[3]], draws: '9m9m', sticks: 2, scores: [25000, 25000, 24000, 24000] });
    tsumogiri(g, 3);
    discard(g, 0, '5s');
    act(g, 1, { type: 'ron' });
    assert.equal(g.result.gameOver, true);
    for (const s of [0, 1, 2, 3]) act(g, s, { type: 'ready' });
    assert.equal(g.phase, 'over');
    assert.equal(total(g), 100000);
  });
  t('result screen: a human who leaves (seat turns bot) does not stall the ready players', () => {
    const g = rig({ hands: ['5s147m258p369s127z', '234m567p234s88s67s', FILL[2], FILL[3]], draws: '9m' });
    discard(g, 0, '5s');
    act(g, 1, { type: 'ron' });
    assert.equal(g.phase, 'end');
    for (const s of [0, 1, 2]) act(g, s, { type: 'ready' });
    assert.equal(g.phase, 'end');
    g.setKind(3, 'bot'); // seat 3 disconnects before saying ready
    assert.equal(g.phase, 'discard', 'next hand starts');
    assert.equal(g.kyoku, 1);
    g.stop();
  });
  t('views never show hidden tiles during play', () => {
    const g = rig({ hands: ['5s147m258p369s127z', '234m567p234s88s67s', FILL[2], FILL[3]], draws: '9m' });
    for (let s = 0; s < 4; s++) checkView(g, g.view(s), s);
  });
}

/* ------------------------------------------------------------------ */
/* Seeded bot games with invariants                                    */
/* ------------------------------------------------------------------ */

// was { ron: 197, tsumo: 96, draw: 24, rounds: 317 } before the rule fixes (agari-yame,
// kuikae, karaten, kan dora timing) and bot changes (kans, yaku-aware tenpai)
export const BOT_BASELINE = { ron: 193, tsumo: 94, draw: 20, rounds: 307 };
const PHASES = ['discard', 'claim', 'end', 'over'];

function checkInvariants(g) {
  assert.ok(PHASES.includes(g.phase), 'phase ' + g.phase);
  const total = g.players.reduce((a, p) => a + p.score, 0) + g.sticks * 1000;
  assert.equal(total, 100000, 'score sum');
  if (g.phase === 'over') return;
  // every tile exactly once: live wall, unused dead wall, hands, melds, discards not called
  const all = [...g.live];
  g.dead.forEach((x, i) => { if (i < 10 || i >= 10 + g.rinshanUsed) all.push(x); });
  assert.equal(g.dead.length, 14 + g.rinshanUsed);
  for (const p of g.players) {
    all.push(...p.hand);
    for (const m of p.melds) all.push(...m.tiles);
    for (const d of p.discards) if (!d.called) all.push(d.tile);
    const n = p.hand.length + 3 * p.melds.length;
    const active = (g.phase === 'discard' && g.turn === p.seat) || (g.phase === 'end' && g.result.type === 'tsumo' && g.result.winner === p.seat);
    assert.equal(n, active ? 14 : 13, `seat ${p.seat} holds ${n} tiles in ${g.phase}`);
  }
  assert.equal(all.length, 136, 'tile count');
  assert.equal(new Set(all).size, 136, 'tiles unique');
  assert.equal(g.doraCount + g.doraPending, 1 + g.kans, 'one dora per kan');
  assert.ok(g.kans <= 4 && g.rinshanUsed === g.kans);
}

// Plays `count` bot-only games (seeds i * 7919) on a fake clock; returns stats.
export function runBotGames(count, length = 2, onView = null) {
  const clock = installFakeClock();
  const stats = { ron: 0, tsumo: 0, draw: 0, rounds: 0 };
  const extra = { kans: 0, riichi: 0, calls: 0, yakuman: 0, illegal: 0 };
  const origError = console.error;
  console.error = (...a) => { throw new Error('console.error: ' + a.map(String).join(' ')); };
  try {
    for (let i = 1; i <= count; i++) {
      let seed = i * 7919;
      const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
      let done = null;
      const g = new Game([0, 1, 2, 3].map((k) => ({ name: 'B' + k, kind: 'bot' })), {
        length, botDelay: 0, rng,
        onChange: (gg) => {
          checkInvariants(gg);
          for (let k = 0; k < 4; k++) {
            const v = gg.view(k);
            checkView(gg, v, k);
            if (onView) onView(gg, v, k);
          }
          if (gg.phase === 'end' && gg.__seen !== gg.log.length) {
            gg.__seen = gg.log.length;
            for (const p of gg.players) {
              extra.kans += p.melds.filter((m) => m.type !== 'chi' && m.type !== 'pon').length;
              extra.calls += p.melds.filter((m) => m.type !== 'ankan').length;
              if (p.riichi) extra.riichi++;
            }
            if (gg.result.yakuman) extra.yakuman++;
          }
          if (gg.phase === 'over') done = gg;
        },
      });
      // bots must only ever choose legal actions
      const act = g.act.bind(g);
      g.act = (s, a) => { const ok = act(s, a); if (!ok) extra.illegal++; return ok; };
      const scr = g.setClaimResponse.bind(g);
      g.setClaimResponse = (s, a) => { const ok = scr(s, a); if (!ok) extra.illegal++; return ok; };
      g.start();
      clock.runAll(() => done);
      assert.ok(done, 'game finished, seed ' + i * 7919);
      for (const r of g.log) { stats[r.type]++; stats.rounds++; }
    }
  } finally {
    console.error = origError;
    clock.uninstall();
  }
  assert.equal(extra.illegal, 0, 'bots chose illegal actions');
  return { stats, extra };
}

export function runEngineTests() {
  let n = 0;
  const t = (name, fn) => {
    try { fn(); } catch (e) { e.message = `${name}: ${e.message}`; throw e; }
    n++;
  };
  scoringTests(t);
  scenarioTests(t);
  t('seeded bot games: invariants, legal bot actions, no stalls', () => {
    const t0 = Date.now();
    const { stats, extra } = runBotGames(30);
    console.log('  bot games ok', stats, extra, (Date.now() - t0) + 'ms');
    // regression baseline for these seeds (update when rules or bots change on purpose)
    assert.deepEqual(stats, BOT_BASELINE);
    assert.ok(revealSeen.play > 1000 && revealSeen.end >= 4 * stats.rounds, 'view checks ran ' + JSON.stringify(revealSeen));
  });
  return n;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(runEngineTests(), 'engine tests passed');
