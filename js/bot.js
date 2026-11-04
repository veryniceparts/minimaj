// Simple computer player: shanten/ukeire efficiency with basic defense.
import { tileType, isYaochu, isHonor, doraFromIndicator, countsOf, isRed } from './tiles.js';
import { shanten, forEachImprovingTile, waitsOf, evaluateWin } from './hand.js';

function visibleCounts(g, seat) {
  const v = new Array(34).fill(0);
  for (const id of g.players[seat].hand) v[tileType(id)]++;
  for (const p of g.players) {
    for (const d of p.discards) if (!d.called) v[tileType(d.tile)]++;
    for (const m of p.melds) for (const id of m.tiles) v[tileType(id)]++;
  }
  for (const id of g.doraIndicators()) v[tileType(id)]++;
  return v;
}

function safety(t, q, g) {
  const disc = new Set(q.discards.map((d) => tileType(d.tile)));
  if (disc.has(t)) return 100;
  // tiles discarded by anyone after q's riichi are also safe against q
  const ri = q.discards.findIndex((d) => d.riichi);
  if (ri >= 0) {
    for (const p of g.players) {
      if (p === q) continue;
      // approximate: last few discards of others
      for (const d of p.discards.slice(-Math.max(0, q.discards.length - ri))) {
        if (tileType(d.tile) === t) return 90;
      }
    }
  }
  if (isHonor(t)) return 50;
  const n = t % 9;
  const suji = (n < 3 || disc.has(t - 3)) && (n > 5 || disc.has(t + 3));
  if (suji) return isYaochu(t) ? 70 : 55;
  if (isYaochu(t)) return 30;
  if (n === 1 || n === 7) return 15;
  return 0;
}

const isYakuhai = (t, g, seat) => t >= 31 || t === g.seatWind(seat) || t === g.roundWindType();

// An open hand whose only planned yaku is tanyao: no yakuhai triplet or pair.
function needsTanyao(g, seat, c) {
  const p = g.players[seat];
  if (!p.melds.some((m) => m.type !== 'ankan')) return false;
  if (p.melds.some((m) => m.type !== 'chi' && isYakuhai(tileType(m.tiles[0]), g, seat))) return false;
  return !c.some((n, t) => n >= 2 && isYakuhai(t, g, seat));
}

// Does the open hand, after discarding one tile of type t, wait on at least
// one tile that wins with a yaku? (Only called for tenpai discards.)
function tenpaiHasYaku(g, seat, t) {
  const p = g.players[seat];
  const i = p.hand.findIndex((id) => tileType(id) === t);
  const rest = p.hand.slice(0, i).concat(p.hand.slice(i + 1));
  for (const w of waitsOf(countsOf(rest), p.melds.length)) {
    const ctx = g.winCtx(seat, w * 4 + 3, false);
    ctx.hand = rest.concat([w * 4 + 3]);
    ctx.ippatsu = false;
    if (evaluateWin(ctx)) return true;
  }
  return false;
}

function tileValue(t, g, seat) {
  // lower = discard earlier
  const p = g.players[seat];
  const dora = g.doraIndicators().map((id) => doraFromIndicator(tileType(id)));
  let v;
  if (isHonor(t)) {
    v = isYakuhai(t, g, seat) ? 2 : 0;
  } else if (isYaochu(t)) v = 3;
  else if (t % 9 === 1 || t % 9 === 7) v = 4;
  else v = 5;
  if (dora.includes(t)) v += 4;
  if (p.hand.some((id) => tileType(id) === t && isRed(id))) v += 3;
  return v;
}

export function chooseDiscard(g, seat, allowed) {
  const p = g.players[seat];
  const open = p.melds.length;
  const c = countsOf(p.hand);
  const vis = visibleCounts(g, seat);
  const types = [...new Set(allowed.map(tileType))];
  const evals = types.map((t) => {
    c[t]--;
    const sh = shanten(c, open);
    c[t]++;
    return { t, sh };
  });
  const minSh = Math.min(...evals.map((e) => e.sh));
  for (const e of evals) {
    e.uke = 0;
    if (e.sh > minSh + 1) continue;
    c[e.t]--;
    forEachImprovingTile(c, open, e.sh, (u) => { e.uke += Math.max(0, 4 - vis[u]); });
    c[e.t]++;
    e.val = tileValue(e.t, g, seat);
  }

  const threats = g.players.filter((q, i) => i !== seat && (q.riichi || q.riichiPending));
  let pick;
  if (threats.length && minSh >= 1) {
    for (const e of evals) e.safe = Math.min(...threats.map((q) => safety(e.t, q, g)));
    // fold when far from tenpai, otherwise only consider reasonably efficient tiles
    const pool = minSh >= 2 ? evals : evals.filter((e) => e.sh === minSh);
    pool.sort((a, b) => b.safe - a.safe || a.sh - b.sh || b.uke - a.uke);
    pick = pool[0];
  } else {
    const pool = evals.filter((e) => e.sh === minSh);
    // an open tanyao hand throws terminals and honors first, or it ends without a yaku
    const tan = needsTanyao(g, seat, c);
    // open and tenpai: prefer waits that can actually win (a yaku on some wait)
    if (minSh === 0 && open > 0) for (const e of pool) e.yaku = tenpaiHasYaku(g, seat, e.t) ? 1 : 0;
    pool.sort((a, b) => (b.yaku || 0) - (a.yaku || 0) || (tan ? isYaochu(b.t) - isYaochu(a.t) : 0) || b.uke - a.uke || a.val - b.val);
    pick = pool[0];
  }
  // choose a concrete id: prefer non-red copy, drawn tile last
  const ids = allowed.filter((id) => tileType(id) === pick.t);
  ids.sort((a, b) => (isRed(a) - isRed(b)) || ((b === p.drawn) - (a === p.drawn)));
  return { id: ids[0], sh: pick.sh };
}

export function botTurn(g, seat) {
  const o = g.turnOptions(seat);
  const p = g.players[seat];
  if (o.tsumo) return { type: 'tsumo' };
  if (p.riichi) return { type: 'discard', tile: o.discard[0] };
  const { id, sh } = chooseDiscard(g, seat, o.discard);
  // a closed or added kan when it costs no shanten (and no one is in riichi for an added kan)
  if (o.ankan.length || o.kakan.length) {
    const c = countsOf(p.hand);
    const open = p.melds.length;
    for (const t of o.ankan) {
      c[t] -= 4;
      const s2 = shanten(c, open + 1);
      c[t] += 4;
      if (s2 <= sh) return { type: 'ankan', t };
    }
    const danger = g.players.some((q, i) => i !== seat && (q.riichi || q.riichiPending));
    for (const t of o.kakan) {
      if (danger) break;
      c[t]--;
      const s2 = shanten(c, open);
      c[t]++;
      if (s2 <= sh) return { type: 'kakan', t };
    }
  }
  if (o.riichi.length) {
    if (o.riichi.includes(id)) return { type: 'discard', tile: id, riichi: true };
    const r = chooseDiscard(g, seat, o.riichi);
    return { type: 'discard', tile: r.id, riichi: true };
  }
  return { type: 'discard', tile: id };
}

export function botClaim(g, seat, o) {
  if (o.ron) return { type: 'ron' };
  const p = g.players[seat];
  const tile = g.claim.tile;
  const t = tileType(tile);
  const yakuhaiT = (x) => x >= 31 || x === g.seatWind(seat) || x === g.roundWindType();
  const c = countsOf(p.hand);
  const sh0 = shanten(c, p.melds.length);
  const hasYakuhaiMeld = p.melds.some((m) => yakuhaiT(tileType(m.tiles[0])) && m.type !== 'chi');
  const handYakuhaiPair = c.some((n, x) => n >= 2 && yakuhaiT(x));
  const allSimple = p.hand.every((id) => !isYaochu(tileType(id))) &&
    p.melds.every((m) => m.tiles.every((id) => !isYaochu(tileType(id))));

  if (o.pon) {
    if (yakuhaiT(t)) return { type: 'pon' };
    c[t] -= 2;
    const sh = shanten(c, p.melds.length + 1);
    c[t] += 2;
    if (sh < sh0 && (hasYakuhaiMeld || handYakuhaiPair || (allSimple && !isYaochu(t)))) return { type: 'pon' };
  }
  if (o.chi && o.chi.length) {
    let best = null;
    for (const pair of o.chi) {
      c[pair[0]]--; c[pair[1]]--;
      const sh = shanten(c, p.melds.length + 1);
      c[pair[0]]++; c[pair[1]]++;
      const simple = !isYaochu(t) && !isYaochu(pair[0]) && !isYaochu(pair[1]);
      if (sh < sh0 && (hasYakuhaiMeld || handYakuhaiPair || (allSimple && simple)) && (!best || sh < best.sh)) best = { pair, sh };
    }
    if (best) return { type: 'chi', tiles: best.pair };
  }
  return { type: 'pass' };
}
