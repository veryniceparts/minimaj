// Hand analysis: shanten, waits, win decomposition, yaku, fu and points.
import {
  tileType, isRed, isYaochu, isTerminal, isHonor, isDragon, isWind,
  suitOf, doraFromIndicator, countsOf,
} from './tiles.js';

/* ------------------------------------------------------------------ */
/* Shanten                                                             */
/* ------------------------------------------------------------------ */

// Standard-form shanten.
//
// Each suit (9 counts, base-5 key) is summarised once: for pair p (0/1) and
// mentsu m (0..4), the most taatsu (capped at 4) any split of the suit reaches
// with that pair flag and at least m mentsu (-1 = impossible). The ten values
// sit in a growing Int8Array pool; a flat Int32Array indexed by the suit key
// holds pool offset + 1 (0 = not computed yet). shantenStd then combines three
// summaries with a small max-plus convolution: no Maps, no allocations.
// Exactly the same results as enumerating every split of the whole hand.
const SUIT_KEYS = 1953125; // 5^9
const suitIndex = new Int32Array(SUIT_KEYS);
let pool = new Int8Array(10 * 4096);
let poolUsed = 0;
const ENUM = new Int8Array(9);
const BEST = new Int8Array(10);

function enumSuit(i, m, t, p) {
  const a = ENUM;
  while (i < 9 && a[i] === 0) i++;
  if (i === 9) {
    if (m > 4) m = 4;
    if (t > 4) t = 4;
    for (let k = p * 5, e = k + m; k <= e; k++) if (BEST[k] < t) BEST[k] = t;
    return;
  }
  if (a[i] >= 3) { a[i] -= 3; enumSuit(i, m + 1, t, p); a[i] += 3; }
  if (i <= 6 && a[i + 1] && a[i + 2]) {
    a[i]--; a[i + 1]--; a[i + 2]--; enumSuit(i, m + 1, t, p); a[i]++; a[i + 1]++; a[i + 2]++;
  }
  if (a[i] >= 2) {
    a[i] -= 2;
    if (p === 0) enumSuit(i, m, t, 1);
    enumSuit(i, m, t + 1, p);
    a[i] += 2;
  }
  if (i <= 7 && a[i + 1]) { a[i]--; a[i + 1]--; enumSuit(i, m, t + 1, p); a[i]++; a[i + 1]++; }
  if (i <= 6 && a[i + 2]) { a[i]--; a[i + 2]--; enumSuit(i, m, t + 1, p); a[i]++; a[i + 2]++; }
  a[i]--; enumSuit(i, m, t, p); a[i]++;
}

// pool offset of the summary of suit c[o..o+8]
function suitOff(c, o) {
  const key = c[o] * 390625 + c[o + 1] * 78125 + c[o + 2] * 15625 + c[o + 3] * 3125 + c[o + 4] * 625 +
    c[o + 5] * 125 + c[o + 6] * 25 + c[o + 7] * 5 + c[o + 8];
  const r = suitIndex[key];
  if (r !== 0) return r - 1;
  for (let i = 0; i < 9; i++) ENUM[i] = c[o + i];
  BEST.fill(-1);
  enumSuit(0, 0, 0, 0);
  if (poolUsed + 10 > pool.length) {
    const np = new Int8Array(pool.length * 2);
    np.set(pool);
    pool = np;
  }
  const off = poolUsed;
  pool.set(BEST, off);
  poolUsed += 10;
  suitIndex[key] = off + 1;
  return off;
}

// Combine three suit summaries (pool offsets) with h3 honor triplets and h2
// honor pairs. Values are non-increasing in m, and p=1 possible implies p=0
// possible, so each loop stops at the first impossible p=0 entry.
const AB = new Int8Array(10);
function stdCore(oa, ob, oc, h3, h2, open) {
  const P = pool;
  for (let k = 0; k < 10; k++) AB[k] = -1;
  for (let ma = 0; ma < 5; ma++) {
    const a0 = P[oa + ma];
    if (a0 < 0) break;
    const a1 = P[oa + 5 + ma];
    for (let mb = 0; ma + mb < 5; mb++) {
      const b0 = P[ob + mb];
      if (b0 < 0) break;
      const b1 = P[ob + 5 + mb];
      const k = ma + mb;
      if (a0 + b0 > AB[k]) AB[k] = a0 + b0;
      if (a1 >= 0 && a1 + b0 > AB[5 + k]) AB[5 + k] = a1 + b0;
      if (b1 >= 0 && a0 + b1 > AB[5 + k]) AB[5 + k] = a0 + b1;
    }
  }
  const need = 4 - open;
  let best = 8;
  for (let ma = 0; ma < 5; ma++) {
    const a0 = AB[ma];
    if (a0 < 0) break;
    const a1 = AB[5 + ma];
    for (let mb = 0; ma + mb < 5; mb++) {
      const b0 = P[oc + mb];
      if (b0 < 0) break;
      const b1 = P[oc + 5 + mb];
      let m = ma + mb + h3;
      if (m > need) m = need;
      const room = need - m;
      // no pair from the suits (an honor pair, if any, is the pair: never worse)
      let t = a0 + b0 + h2, p = 0;
      if (h2 > 0) { t--; p = 1; }
      let s = 8 - 2 * (m + open) - (t < room ? t : room) - p;
      if (s < best) best = s;
      // the pair from one of the suits
      t = a1 >= 0 ? a1 + b0 : -1;
      if (b1 >= 0 && a0 + b1 > t) t = a0 + b1;
      if (t >= 0) {
        t += h2;
        s = 7 - 2 * (m + open) - (t < room ? t : room);
        if (s < best) best = s;
      }
    }
  }
  return best;
}

export function shantenStd(c, open) {
  const oa = suitOff(c, 0), ob = suitOff(c, 9), oc = suitOff(c, 18);
  let h3 = 0, h2 = 0;
  for (let h = 27; h < 34; h++) {
    const n = c[h];
    if (n >= 3) h3++;
    else if (n === 2) h2++;
  }
  return stdCore(oa, ob, oc, h3, h2, open);
}

export function shantenChiitoi(c) {
  let pairs = 0, kinds = 0;
  for (let i = 0; i < 34; i++) {
    if (c[i] >= 1) kinds++;
    if (c[i] >= 2) pairs++;
  }
  return 6 - pairs + Math.max(0, 7 - kinds);
}

const YAOCHU = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
const IS_YAOCHU = new Int8Array(34);
for (const t of YAOCHU) IS_YAOCHU[t] = 1;

export function shantenKokushi(c) {
  let kinds = 0, pair = 0;
  for (const t of YAOCHU) {
    if (c[t] >= 1) kinds++;
    if (c[t] >= 2) pair = 1;
  }
  return 13 - kinds - pair;
}

// c: counts of concealed tiles; open: number of declared melds.
export function shanten(c, open = 0) {
  let s = shantenStd(c, open);
  if (open === 0) s = Math.min(s, shantenChiitoi(c), shantenKokushi(c));
  return s;
}

export const isAgariCounts = (c, open) => shanten(c, open) === -1;

// True when tile type u is absent and has no same-suit neighbour within 2:
// adding it cannot change the standard-form shanten.
function isolatedType(c, u) {
  if (c[u]) return false;
  if (u >= 27) return true;
  const n = u % 9;
  return !((n >= 2 && c[u - 2]) || (n >= 1 && c[u - 1]) || (n <= 7 && c[u + 1]) || (n <= 6 && c[u + 2]));
}

// shanten(c + u, open) for every tile type u with c[u] < 4, written to out[u]
// (out[u] = 99 when c[u] = 4). Only the suit that changes is re-summarised and
// the chiitoitsu / kokushi counts are updated incrementally.
const ADD_OUT = new Int8Array(34);
function shantenAfterEachAdd(c, open, out) {
  const offs = [suitOff(c, 0), suitOff(c, 9), suitOff(c, 18)];
  let h3 = 0, h2 = 0;
  for (let h = 27; h < 34; h++) {
    if (c[h] >= 3) h3++;
    else if (c[h] === 2) h2++;
  }
  const std = stdCore(offs[0], offs[1], offs[2], h3, h2, open);
  let pairs = 0, kinds = 0, yk = 0, yp = 0;
  if (open === 0) {
    for (let i = 0; i < 34; i++) {
      if (c[i] >= 1) { kinds++; if (IS_YAOCHU[i]) yk++; }
      if (c[i] >= 2) { pairs++; if (IS_YAOCHU[i]) yp = 1; }
    }
  }
  for (let u = 0; u < 34; u++) {
    const n = c[u];
    if (n >= 4) { out[u] = 99; continue; }
    let s;
    if (isolatedType(c, u)) s = std;
    else if (u >= 27) {
      // honors: 1 -> 2 adds a pair, 2 -> 3 turns a pair into a triplet, 3 -> 4 changes nothing
      s = n === 1 ? stdCore(offs[0], offs[1], offs[2], h3, h2 + 1, open)
        : n === 2 ? stdCore(offs[0], offs[1], offs[2], h3 + 1, h2 - 1, open) : std;
    } else {
      const k = (u / 9) | 0;
      c[u]++;
      const o = suitOff(c, 9 * k);
      c[u]--;
      s = k === 0 ? stdCore(o, offs[1], offs[2], h3, h2, open)
        : k === 1 ? stdCore(offs[0], o, offs[2], h3, h2, open) : stdCore(offs[0], offs[1], o, h3, h2, open);
    }
    if (open === 0) {
      const k2 = kinds + (n === 0 ? 1 : 0);
      const chi = 6 - pairs - (n === 1 ? 1 : 0) + (k2 < 7 ? 7 - k2 : 0);
      const kok = 13 - yk - (n === 0 ? IS_YAOCHU[u] : 0) - (yp || (n === 1 && IS_YAOCHU[u]) ? 1 : 0);
      if (chi < s) s = chi;
      if (kok < s) s = kok;
    }
    out[u] = s;
  }
}

// Calls fn(u) for every tile type u whose addition lowers shanten(c, open)
// below sh (normally sh = shanten(c, open)), in increasing u. fn must not
// call forEachImprovingTile / waitsOf itself (they share a scratch buffer).
export function forEachImprovingTile(c, open, sh, fn) {
  const out = ADD_OUT;
  shantenAfterEachAdd(c, open, out);
  for (let u = 0; u < 34; u++) if (out[u] < sh) fn(u);
}

// Tile types that complete a 13-tile (3n+1) concealed hand.
export function waitsOf(c, open) {
  const out = ADD_OUT;
  shantenAfterEachAdd(c, open, out);
  const res = [];
  for (let u = 0; u < 34; u++) if (out[u] === -1) res.push(u);
  return res;
}

/* ------------------------------------------------------------------ */
/* Win evaluation                                                      */
/* ------------------------------------------------------------------ */

function decompose(c) {
  const res = [];
  const sets = [];
  let pair = -1;
  const dfs = (i) => {
    while (i < 34 && c[i] === 0) i++;
    if (i === 34) { res.push({ pair, sets: sets.slice() }); return; }
    if (c[i] >= 3) {
      c[i] -= 3; sets.push({ k: 'trip', t: i }); dfs(i); sets.pop(); c[i] += 3;
    }
    if (i < 27 && i % 9 <= 6 && c[i + 1] && c[i + 2]) {
      c[i]--; c[i + 1]--; c[i + 2]--;
      sets.push({ k: 'seq', t: i }); dfs(i); sets.pop();
      c[i]++; c[i + 1]++; c[i + 2]++;
    }
  };
  for (let p = 0; p < 34; p++) {
    if (c[p] >= 2) { c[p] -= 2; pair = p; dfs(0); c[p] += 2; }
  }
  return res;
}

export const LIMIT_NAMES = { 2000: 'Mangan', 3000: 'Haneman', 4000: 'Baiman', 6000: 'Sanbaiman', 8000: 'Yakuman' };

export function basePoints(han, fu, yakuman) {
  if (yakuman) return 8000 * yakuman;
  if (han >= 13) return 8000;
  if (han >= 11) return 6000;
  if (han >= 8) return 4000;
  if (han >= 6) return 3000;
  if (han >= 5) return 2000;
  return Math.min(2000, fu * 2 ** (han + 2));
}

function meldBlocks(melds) {
  return melds.map((m) => {
    const ts = m.tiles.map(tileType);
    const t = Math.min(...ts);
    if (m.type === 'chi') return { k: 'seq', t, open: true };
    if (m.type === 'pon') return { k: 'trip', t, open: true };
    if (m.type === 'ankan') return { k: 'kan', t, open: false };
    return { k: 'kan', t, open: true };
  });
}

const tripLike = (b) => b.k === 'trip' || b.k === 'kan';

// ctx: { hand:[ids incl. winning tile], melds, winTile, tsumo, seatWind, roundWind,
//        riichi, doubleRiichi, ippatsu, haitei, houtei, rinshan, chankan, tenhou, chiihou,
//        dora:[indicator types], ura:[indicator types] }
// Returns best { yaku:[[name, han]], han, fu, yakuman, base, limit } or null (no yaku).
export function evaluateWin(ctx) {
  const c = countsOf(ctx.hand);
  const melds = ctx.melds || [];
  const open = melds.length;
  const menzen = melds.every((m) => m.type === 'ankan');
  const winT = tileType(ctx.winTile);
  const allIds = ctx.hand.concat(...melds.map((m) => m.tiles));
  const allT = allIds.map(tileType);
  const allC = countsOf(allIds);

  // situational yaku
  const sit = [];
  if (ctx.riichi) sit.push(ctx.doubleRiichi ? ['Double Riichi', 2] : ['Riichi', 1]);
  if (ctx.ippatsu) sit.push(['Ippatsu', 1]);
  if (ctx.tsumo && menzen) sit.push(['Menzen Tsumo', 1]);
  if (ctx.haitei) sit.push(['Haitei Raoyue', 1]);
  if (ctx.houtei) sit.push(['Houtei Raoyui', 1]);
  if (ctx.rinshan) sit.push(['Rinshan Kaihou', 1]);
  if (ctx.chankan) sit.push(['Chankan', 1]);
  const sitYakuman = [];
  if (ctx.tenhou) sitYakuman.push(['Tenhou', 1]);
  if (ctx.chiihou) sitYakuman.push(['Chiihou', 1]);

  // whole-hand properties
  const suits = new Set(allT.filter((t) => t < 27).map(suitOf));
  const hasHonor = allT.some(isHonor);
  const allSimple = allT.every((t) => !isYaochu(t));
  const allHonor = allT.every(isHonor);
  const allTerm = allT.every(isTerminal);
  const allYaochu = allT.every(isYaochu);
  const GREEN = [19, 20, 21, 23, 25, 32];
  const allGreen = allT.every((t) => GREEN.includes(t));

  const flushYaku = [];
  if (suits.size === 1 && !hasHonor) flushYaku.push(['Chinitsu', menzen ? 6 : 5]);
  else if (suits.size === 1 && hasHonor) flushYaku.push(['Honitsu', menzen ? 3 : 2]);

  const candidates = [];
  const pushResult = (yakuList, fu, yakumanList) => {
    if (yakumanList.length) {
      const n = yakumanList.reduce((s, y) => s + y[1], 0);
      candidates.push({ yaku: yakumanList.map(([nm, k]) => [nm, 13 * k]), han: 13 * n, fu, yakuman: n });
      return;
    }
    if (!yakuList.length) return;
    let han = yakuList.reduce((s, y) => s + y[1], 0);
    const extra = [];
    let dora = 0;
    for (const ind of ctx.dora || []) dora += allC[doraFromIndicator(ind)];
    const aka = allIds.filter(isRed).length;
    let ura = 0;
    if (ctx.riichi) for (const ind of ctx.ura || []) ura += allC[doraFromIndicator(ind)];
    if (dora) extra.push(['Dora', dora]);
    if (aka) extra.push(['Aka Dora', aka]);
    if (ura) extra.push(['Ura Dora', ura]);
    han += dora + aka + ura;
    candidates.push({ yaku: yakuList.concat(extra), han, fu, yakuman: 0 });
  };

  // Kokushi
  if (open === 0 && shantenKokushi(c) === -1) {
    pushResult([], 0, [['Kokushi Musou', 1], ...sitYakuman]);
  }

  // Chiitoitsu
  if (open === 0 && shantenChiitoi(c) === -1) {
    const ym = [...sitYakuman];
    if (allHonor) ym.push(['Tsuuiisou', 1]);
    const y = [...sit, ['Chiitoitsu', 2]];
    if (allSimple) y.push(['Tanyao', 1]);
    if (allYaochu) y.push(['Honroutou', 2]);
    y.push(...flushYaku);
    pushResult(y, 25, ym);
  }

  // Standard hands
  const dragonsOrWinds = (t) => isDragon(t) || t === ctx.seatWind || t === ctx.roundWind;
  for (const dec of decompose(c.slice())) {
    // choices of where the winning tile sits
    const spots = [];
    if (dec.pair === winT) spots.push(-1);
    dec.sets.forEach((s, i) => {
      if ((s.k === 'trip' && s.t === winT) || (s.k === 'seq' && winT >= s.t && winT <= s.t + 2)) spots.push(i);
    });
    const seenSpot = new Set();
    for (const spot of spots) {
      const sig = spot === -1 ? 'p' : `${dec.sets[spot].k}${dec.sets[spot].t}:${winT - dec.sets[spot].t}`;
      if (seenSpot.has(sig)) continue;
      seenSpot.add(sig);

      const blocks = dec.sets.map((s, i) => ({ k: s.k, t: s.t, open: !ctx.tsumo && i === spot && s.k === 'trip' }));
      blocks.push(...meldBlocks(melds));
      let wait;
      if (spot === -1) wait = 'tanki';
      else {
        const s = dec.sets[spot];
        if (s.k === 'trip') wait = 'shanpon';
        else if (winT === s.t + 1) wait = 'kanchan';
        else if ((winT === s.t && s.t % 9 === 6) || (winT === s.t + 2 && s.t % 9 === 0)) wait = 'penchan';
        else wait = 'ryanmen';
      }
      const pair = dec.pair;
      const seqs = blocks.filter((b) => b.k === 'seq');
      const trips = blocks.filter(tripLike);
      const concealedTrips = trips.filter((b) => !b.open).length;
      const kans = blocks.filter((b) => b.k === 'kan').length;

      // yakuman
      const ym = [...sitYakuman];
      if (concealedTrips === 4) ym.push(['Suuankou', 1]);
      const dragonTrips = trips.filter((b) => isDragon(b.t)).length;
      const windTrips = trips.filter((b) => isWind(b.t)).length;
      if (dragonTrips === 3) ym.push(['Daisangen', 1]);
      if (windTrips === 4) ym.push(['Daisuushii', 1]);
      else if (windTrips === 3 && isWind(pair)) ym.push(['Shousuushii', 1]);
      if (allHonor) ym.push(['Tsuuiisou', 1]);
      if (allTerm) ym.push(['Chinroutou', 1]);
      if (allGreen) ym.push(['Ryuuiisou', 1]);
      if (kans === 4) ym.push(['Suukantsu', 1]);
      if (menzen && open === 0 && suits.size === 1 && !hasHonor) {
        const o = [...suits][0] * 9;
        const k = c.slice(o, o + 9);
        if (k[0] >= 3 && k[8] >= 3 && k.slice(1, 8).every((x) => x >= 1)) ym.push(['Chuuren Poutou', 1]);
      }
      if (ym.length) { pushResult([], 0, ym); continue; }

      const y = [...sit];
      const pinfu = menzen && seqs.length === 4 && !dragonsOrWinds(pair) && wait === 'ryanmen';
      if (pinfu) y.push(['Pinfu', 1]);
      if (allSimple) y.push(['Tanyao', 1]);
      for (const b of trips) {
        if (isDragon(b.t)) y.push([['Haku', 'Hatsu', 'Chun'][b.t - 31], 1]);
        if (b.t === ctx.seatWind) y.push(['Seat Wind', 1]);
        if (b.t === ctx.roundWind) y.push(['Round Wind', 1]);
      }
      if (menzen) {
        let peiko = 0;
        const cnt = {};
        for (const b of seqs) cnt[b.t] = (cnt[b.t] || 0) + 1;
        for (const t in cnt) peiko += Math.floor(cnt[t] / 2);
        if (peiko >= 2) y.push(['Ryanpeikou', 3]);
        else if (peiko === 1) y.push(['Iipeikou', 1]);
      }
      const seqStarts = new Set(seqs.map((b) => b.t));
      for (let n = 0; n < 7; n++) {
        if (seqStarts.has(n) && seqStarts.has(n + 9) && seqStarts.has(n + 18)) {
          y.push(['Sanshoku Doujun', menzen ? 2 : 1]); break;
        }
      }
      for (let s = 0; s < 3; s++) {
        if (seqStarts.has(s * 9) && seqStarts.has(s * 9 + 3) && seqStarts.has(s * 9 + 6)) {
          y.push(['Ittsu', menzen ? 2 : 1]); break;
        }
      }
      if (trips.length === 4) y.push(['Toitoi', 2]);
      if (concealedTrips === 3) y.push(['Sanankou', 2]);
      const tripT = new Set(trips.map((b) => b.t));
      for (let n = 0; n < 9; n++) {
        if (tripT.has(n) && tripT.has(n + 9) && tripT.has(n + 18)) { y.push(['Sanshoku Doukou', 2]); break; }
      }
      if (kans === 3) y.push(['Sankantsu', 2]);
      if (dragonTrips === 2 && isDragon(pair)) y.push(['Shousangen', 2]);
      if (allYaochu) y.push(['Honroutou', 2]);
      else {
        const blockHasYaochu = (b) => (b.k === 'seq' ? b.t % 9 === 0 || b.t % 9 === 6 : isYaochu(b.t));
        if (seqs.length > 0 && isYaochu(pair) && blocks.every(blockHasYaochu)) {
          if (hasHonor) y.push(['Chanta', menzen ? 2 : 1]);
          else y.push(['Junchan', menzen ? 3 : 2]);
        }
      }
      y.push(...flushYaku);

      // fu
      let fu;
      if (pinfu) fu = ctx.tsumo ? 20 : 30;
      else {
        fu = 20;
        if (menzen && !ctx.tsumo) fu += 10;
        if (ctx.tsumo) fu += 2;
        for (const b of trips) {
          let f = isYaochu(b.t) ? 4 : 2;
          if (!b.open) f *= 2;
          if (b.k === 'kan') f *= 4;
          fu += f;
        }
        if (isDragon(pair)) fu += 2;
        if (pair === ctx.seatWind) fu += 2;
        if (pair === ctx.roundWind) fu += 2;
        if (wait === 'tanki' || wait === 'kanchan' || wait === 'penchan') fu += 2;
        fu = Math.ceil(fu / 10) * 10;
        if (fu < 30) fu = 30;
      }
      pushResult(y, fu, []);
    }
  }

  if (!candidates.length) return null;
  for (const r of candidates) {
    r.base = basePoints(r.han, r.fu, r.yakuman);
    r.limit = r.yakuman ? (r.yakuman > 1 ? `${r.yakuman}x Yakuman` : 'Yakuman')
      : r.han >= 13 ? 'Kazoe Yakuman' : (r.base >= 2000 ? LIMIT_NAMES[r.base] : '');
  }
  candidates.sort((a, b) => b.base - a.base || b.han - a.han || b.fu - a.fu);
  return candidates[0];
}

export const roundUp100 = (x) => Math.ceil(x / 100) * 100;
