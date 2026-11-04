// Authoritative riichi game engine. Runs on the host only.
import { tileType, isRed, countsOf, sortIds } from './tiles.js';
import { shanten, waitsOf, evaluateWin, roundUp100 } from './hand.js';
import { botTurn, botClaim } from './bot.js';

// Tile types a player may not discard right after a call (kuikae): the called
// type, and for a chi the tile at the other end of the run (calling 3 with 45
// forbids 3 and 6).
function kuikaeTypes(type, t, pair) {
  if (type === 'pon') return [t];
  if (type !== 'chi') return [];
  const [a, b] = pair;
  const out = [t];
  if (t < a && b % 9 < 8) out.push(b + 1);
  if (t > b && a % 9 > 0) out.push(a - 1);
  return out;
}

const shuffle = (a, rng) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export class Game {
  // players: [{name, kind:'human'|'bot'}] x4 in seat order (seat 0 = first East)
  constructor(players, opts = {}) {
    // animal: the seat's mascot (index into js/animals.js), picked by the room; display only
    this.players = players.map((p, i) => ({ name: p.name, kind: p.kind, seat: i, score: 25000, animal: Number.isInteger(p.animal) ? p.animal : i }));
    this.length = opts.length || 1; // 1 = East only, 2 = East + South
    this.botDelay = opts.botDelay ?? 700;
    this.onChange = opts.onChange || (() => {});
    this.rng = opts.rng || Math.random;
    this.round = 0;
    this.kyoku = 0;
    this.honba = 0;
    this.sticks = 0;
    this.phase = 'init';
    this.version = 0;
    this.event = null;
    this.eventId = 0;
    this.log = [];
  }

  get dealer() { return this.kyoku; }
  seatWind(s) { return 27 + ((s - this.dealer + 4) % 4); }
  roundWindType() { return 27 + this.round; }
  doraIndicators() { return this.dead.slice(0, this.doraCount); }
  isBot(s) { return this.players[s].kind === 'bot'; }

  start() { this.startRound(); this.changed(); }

  setKind(seat, kind, name) {
    this.players[seat].kind = kind;
    if (name) this.players[seat].name = name;
    this.changed();
  }

  announce(seat, text) {
    this.event = { id: ++this.eventId, seat, text };
  }

  /* ---------------- round flow ---------------- */

  startRound() {
    const tiles = shuffle([...Array(136).keys()], this.rng);
    // dead wall: 0-4 dora indicators, 5-9 ura indicators, 10-13 rinshan tiles;
    // live tiles that replace rinshan draws are appended after index 13
    this.dead = tiles.slice(0, 14);
    this.live = tiles.slice(14);
    this.doraCount = 1;
    this.doraPending = 0; // open kans whose dora is turned after the next discard
    this.kans = 0;
    this.rinshanUsed = 0;
    this.anyCall = false;
    this.result = null;
    this.ready = new Set();
    this.claim = null;
    this.lastDiscard = null;
    this.rinshan = false;
    this.mustDiscard = false;
    this.event = null;
    for (const p of this.players) {
      Object.assign(p, {
        hand: [], melds: [], discards: [], riichi: false, riichiPending: false, riichiDouble: false,
        ippatsu: false, doubleRiichi: false, furitenTemp: false, furitenRiichi: false,
        drawn: null, kuikae: [], waits: [],
      });
    }
    for (let k = 0; k < 13; k++) for (let s = 0; s < 4; s++) this.players[(this.dealer + s) % 4].hand.push(this.live.pop());
    for (const p of this.players) this.updateWaits(p);
    this.drawTile(this.dealer, false);
  }

  updateWaits(p) {
    p.waits = p.hand.length % 3 === 1 ? this.liveWaits(p.hand, p.melds) : [];
  }

  // Waits of a 13-tile (3n+1) hand, leaving out tile types the player already
  // holds all four of in hand and melds (karaten: no fifth tile exists).
  liveWaits(hand, melds) {
    const waits = waitsOf(countsOf(hand), melds.length);
    if (!waits.length) return waits;
    const own = countsOf(hand);
    for (const m of melds) for (const id of m.tiles) own[tileType(id)]++;
    return waits.filter((t) => own[t] < 4);
  }

  // Turn the kan dora of open kans declared earlier (after a discard or a new kan).
  flipPendingDora() {
    this.doraCount += this.doraPending;
    this.doraPending = 0;
  }

  isFuriten(p) {
    if (p.furitenTemp || p.furitenRiichi) return true;
    return p.waits.some((w) => p.discards.some((d) => tileType(d.tile) === w));
  }

  drawTile(seat, rinshan) {
    const p = this.players[seat];
    let t;
    if (rinshan) {
      t = this.dead[10 + this.rinshanUsed++];
      this.dead.push(this.live.shift()); // the last live tile joins the dead wall (it stays at 14)
    } else {
      t = this.live.pop();
    }
    p.hand.push(t);
    p.drawn = t;
    this.rinshan = rinshan;
    this.turn = seat;
    this.phase = 'discard';
    this.mustDiscard = false;
  }

  winCtx(seat, tileId, tsumo, extra = {}) {
    const p = this.players[seat];
    const first = p.discards.length === 0 && !this.anyCall;
    return {
      hand: tsumo ? p.hand.slice() : p.hand.concat([tileId]),
      melds: p.melds,
      winTile: tileId,
      tsumo,
      seatWind: this.seatWind(seat),
      roundWind: this.roundWindType(),
      riichi: p.riichi,
      doubleRiichi: p.doubleRiichi,
      ippatsu: p.riichi && p.ippatsu,
      haitei: tsumo && this.live.length === 0 && !this.rinshan,
      houtei: !tsumo && this.live.length === 0 && !extra.chankan,
      rinshan: tsumo && this.rinshan,
      chankan: !!extra.chankan,
      tenhou: tsumo && first && seat === this.dealer && !this.rinshan,
      chiihou: tsumo && first && seat !== this.dealer && !this.rinshan,
      dora: this.doraIndicators().map(tileType),
      ura: this.dead.slice(5, 5 + this.doraCount).map(tileType),
    };
  }

  evalWin(seat, tileId, tsumo, extra) {
    return evaluateWin(this.winCtx(seat, tileId, tsumo, extra));
  }

  turnOptions(seat) {
    if (this.phase !== 'discard' || this.turn !== seat) return null;
    const p = this.players[seat];
    const o = { discard: [], riichi: [], tsumo: false, ankan: [], kakan: [] };
    if (p.riichi) o.discard = [p.drawn];
    else {
      o.discard = p.hand.filter((id) => !p.kuikae.includes(tileType(id)));
      if (!o.discard.length) o.discard = p.hand.slice();
    }
    if (!this.mustDiscard && p.drawn != null) {
      const c = countsOf(p.hand);
      // (the shanten test is a cheap filter before the full evaluation)
      if (shanten(c, p.melds.length) === -1 && this.evalWin(seat, p.drawn, true)) o.tsumo = true;
      if (!p.riichi && this.live.length > 0 && this.kans < 4) {
        for (let t = 0; t < 34; t++) if (c[t] === 4) o.ankan.push(t);
        for (const m of p.melds) {
          const t = tileType(m.tiles[0]);
          if (m.type === 'pon' && c[t] > 0) o.kakan.push(t);
        }
      }
      const closed = p.melds.every((m) => m.type === 'ankan');
      if (!p.riichi && closed && p.score >= 1000 && this.live.length >= 4) {
        const okTypes = new Set();
        for (let t = 0; t < 34; t++) {
          if (!c[t]) continue;
          c[t]--;
          // tenpai after the discard, with a wait that is not karaten (only
          // possible with a closed kan or four of a kind in hand)
          if (shanten(c, p.melds.length) === 0) {
            if (!p.melds.length && !c.some((x) => x >= 4)) okTypes.add(t);
            else {
              const i = p.hand.findIndex((id) => tileType(id) === t);
              const rest = p.hand.slice(0, i).concat(p.hand.slice(i + 1));
              if (this.liveWaits(rest, p.melds).length) okTypes.add(t);
            }
          }
          c[t]++;
        }
        o.riichi = p.hand.filter((id) => okTypes.has(tileType(id)));
      }
    }
    return o;
  }

  /* ---------------- actions ---------------- */

  act(seat, a) {
    try {
      const ok = this._act(seat, a);
      if (ok) this.changed();
      return ok;
    } catch (e) {
      console.error('action failed', a, e);
      return false;
    }
  }

  _act(seat, a) {
    if (!a || typeof a !== 'object') return false;
    if (this.phase === 'discard' && this.turn === seat) {
      const o = this.turnOptions(seat);
      if (a.type === 'discard') {
        const list = a.riichi ? o.riichi : o.discard;
        if (!list.includes(a.tile)) return false;
        this.doDiscard(seat, a.tile, !!a.riichi);
        return true;
      }
      if (a.type === 'tsumo' && o.tsumo) { this.win(seat, null, this.players[seat].drawn, true, false); return true; }
      if (a.type === 'ankan' && o.ankan.includes(a.t)) { this.doAnkan(seat, a.t); return true; }
      if (a.type === 'kakan' && o.kakan.includes(a.t)) { this.doKakan(seat, a.t); return true; }
      return false;
    }
    if (this.phase === 'claim') {
      if (!this.setClaimResponse(seat, a)) return false;
      this.tryResolveClaim();
      return true;
    }
    if (this.phase === 'end' && a.type === 'ready') {
      this.ready.add(seat);
      this.tryAdvance();
      return true;
    }
    return false;
  }

  // Record a seat's answer to the open claim; false when it is not allowed.
  setClaimResponse(seat, a) {
    const opt = this.claim.opts[seat];
    if (!opt || this.claim.resp[seat] || !a) return false;
    let r;
    if (a.type === 'pass') r = { type: 'pass' };
    else if (a.type === 'ron' && opt.ron) r = { type: 'ron' };
    else if (a.type === 'pon' && opt.pon) r = { type: 'pon' };
    else if (a.type === 'kan' && opt.kan) r = { type: 'kan' };
    else if (a.type === 'chi' && opt.chi && Array.isArray(a.tiles) &&
      opt.chi.some((c) => c[0] === a.tiles[0] && c[1] === a.tiles[1])) {
      r = { type: 'chi', tiles: [a.tiles[0], a.tiles[1]] };
    } else return false;
    this.claim.resp[seat] = r;
    return true;
  }

  doDiscard(seat, id, riichi) {
    const p = this.players[seat];
    p.hand.splice(p.hand.indexOf(id), 1);
    if (p.riichi && p.ippatsu) p.ippatsu = false;
    p.discards.push({ tile: id, riichi, tsumogiri: id === p.drawn, called: false });
    if (riichi) {
      p.riichiPending = true;
      p.riichiDouble = p.discards.length === 1 && !this.anyCall;
      this.announce(seat, 'Riichi');
    }
    p.drawn = null;
    p.kuikae = [];
    p.furitenTemp = false; // temporary furiten lasts until the player's own discard
    this.mustDiscard = false;
    this.rinshan = false;
    this.flipPendingDora();
    this.updateWaits(p);
    this.lastDiscard = { seat, tile: id };
    this.openClaims(seat, id, 'discard');
  }

  establishRiichi(seat) {
    const p = this.players[seat];
    if (!p.riichiPending) return;
    p.riichiPending = false;
    p.riichi = true;
    p.ippatsu = true;
    p.doubleRiichi = p.riichiDouble;
    p.score -= 1000;
    this.sticks++;
  }

  openClaims(from, id, kind) {
    const t = tileType(id);
    const opts = {};
    const waiters = [];
    for (let k = 1; k < 4; k++) {
      const s = (from + k) % 4;
      const p = this.players[s];
      const o = {};
      if (p.waits.includes(t)) {
        waiters.push(s);
        if (!this.isFuriten(p) && this.evalWin(s, id, false, { chankan: kind === 'chankan' })) o.ron = true;
      }
      if (kind === 'discard' && !p.riichi && this.live.length > 0) {
        const c = countsOf(p.hand);
        if (c[t] >= 2) o.pon = true;
        if (c[t] >= 3 && this.kans < 4) o.kan = true;
        if (k === 1 && t < 27) {
          const n = t % 9;
          const chi = [];
          if (n >= 2 && c[t - 2] && c[t - 1]) chi.push([t - 2, t - 1]);
          if (n >= 1 && n <= 7 && c[t - 1] && c[t + 1]) chi.push([t - 1, t + 1]);
          if (n <= 6 && c[t + 1] && c[t + 2]) chi.push([t + 1, t + 2]);
          // no chi that would leave only kuikae-forbidden tiles to discard
          const legal = chi.filter((pair) => {
            c[pair[0]]--; c[pair[1]]--;
            const bad = kuikaeTypes('chi', t, pair);
            const ok = c.some((x, u) => x > 0 && !bad.includes(u));
            c[pair[0]]++; c[pair[1]]++;
            return ok;
          });
          if (legal.length) o.chi = legal;
        }
      }
      if (Object.keys(o).length) opts[s] = o;
    }
    this.claim = { from, tile: id, kind, opts, resp: {}, waiters };
    this.phase = 'claim';
    this.tryResolveClaim();
  }

  tryResolveClaim() {
    const c = this.claim;
    if (Object.keys(c.opts).some((s) => !c.resp[s])) return;
    const order = [1, 2, 3].map((k) => (c.from + k) % 4);
    const pick = (type) => order.find((s) => c.resp[s] && c.resp[s].type === type);
    const ronSeat = pick('ron');
    if (ronSeat != null) {
      this.claim = null;
      this.players[c.from].riichiPending = false;
      this.win(ronSeat, c.from, c.tile, false, c.kind === 'chankan');
      return;
    }
    for (const s of c.waiters) {
      const p = this.players[s];
      p.furitenTemp = true;
      if (p.riichi) p.furitenRiichi = true;
    }
    this.claim = null;
    if (c.kind === 'chankan') { this.finishKakan(c.from); return; }
    this.establishRiichi(c.from);
    const kanSeat = pick('kan');
    if (kanSeat != null) return this.callMeld(kanSeat, 'minkan', c);
    const ponSeat = pick('pon');
    if (ponSeat != null) return this.callMeld(ponSeat, 'pon', c);
    const chiSeat = pick('chi');
    if (chiSeat != null) return this.callMeld(chiSeat, 'chi', c, c.resp[chiSeat].tiles);
    this.nextTurn(c.from);
  }

  takeFromHand(p, t, n) {
    // prefer red fives so they are shown in the meld
    const ids = p.hand.filter((id) => tileType(id) === t).sort((a, b) => isRed(b) - isRed(a)).slice(0, n);
    for (const id of ids) p.hand.splice(p.hand.indexOf(id), 1);
    return ids;
  }

  breakIppatsu() {
    this.anyCall = true;
    for (const q of this.players) q.ippatsu = false;
  }

  callMeld(seat, type, c, chiTiles) {
    const p = this.players[seat];
    const t = tileType(c.tile);
    const fromP = this.players[c.from];
    fromP.discards[fromP.discards.length - 1].called = true;
    let taken;
    if (type === 'chi') taken = [...this.takeFromHand(p, chiTiles[0], 1), ...this.takeFromHand(p, chiTiles[1], 1)];
    else taken = this.takeFromHand(p, t, type === 'minkan' ? 3 : 2);
    p.melds.push({ type, tiles: [...taken, c.tile], from: c.from, called: c.tile });
    this.breakIppatsu();
    this.announce(seat, { chi: 'Chi', pon: 'Pon', minkan: 'Kan' }[type]);
    p.kuikae = kuikaeTypes(type, t, chiTiles);
    this.lastDiscard = null;
    if (type === 'minkan') {
      this.kans++;
      this.flipPendingDora();
      this.doraPending++;
      this.drawTile(seat, true);
      return;
    }
    p.drawn = null;
    this.turn = seat;
    this.phase = 'discard';
    this.mustDiscard = true;
  }

  doAnkan(seat, t) {
    const p = this.players[seat];
    const tiles = this.takeFromHand(p, t, 4);
    p.melds.push({ type: 'ankan', tiles, from: seat });
    this.kans++;
    this.flipPendingDora();
    this.doraCount++; // a closed kan turns its dora at once
    this.breakIppatsu();
    this.announce(seat, 'Kan');
    p.drawn = null;
    this.drawTile(seat, true);
  }

  doKakan(seat, t) {
    const p = this.players[seat];
    const [id] = this.takeFromHand(p, t, 1);
    const m = p.melds.find((x) => x.type === 'pon' && tileType(x.tiles[0]) === t);
    m.type = 'shouminkan';
    m.tiles.push(id);
    m.added = id;
    p.drawn = null;
    this.flipPendingDora();
    this.announce(seat, 'Kan');
    this.openClaims(seat, id, 'chankan');
  }

  finishKakan(seat) {
    this.kans++;
    this.doraPending++;
    this.breakIppatsu();
    this.drawTile(seat, true);
  }

  nextTurn(from) {
    if (this.live.length === 0) { this.exhaustiveDraw(); return; }
    this.drawTile((from + 1) % 4, false);
  }

  /* ---------------- round end ---------------- */

  win(seat, from, tileId, tsumo, chankan) {
    const w = this.evalWin(seat, tileId, tsumo, { chankan });
    const p = this.players[seat];
    const isDealer = seat === this.dealer;
    const deltas = [0, 0, 0, 0];
    let points;
    if (tsumo) {
      const fromDealer = roundUp100(w.base * 2);
      const fromOther = roundUp100(w.base);
      for (let s = 0; s < 4; s++) {
        if (s === seat) continue;
        const pay = (isDealer || s === this.dealer ? fromDealer : fromOther) + 100 * this.honba;
        deltas[s] -= pay;
        deltas[seat] += pay;
      }
      points = isDealer ? `${fromDealer} all` : `${fromOther} / ${fromDealer}`;
    } else {
      const pay = roundUp100(w.base * (isDealer ? 6 : 4));
      deltas[from] -= pay + 300 * this.honba;
      deltas[seat] += pay + 300 * this.honba;
      points = `${pay}`;
    }
    deltas[seat] += this.sticks * 1000;
    this.sticks = 0;
    this.players.forEach((q, i) => { q.score += deltas[i]; });
    const hand = tsumo ? p.hand.filter((id) => id !== tileId) : p.hand.slice();
    this.announce(seat, tsumo ? 'Tsumo' : 'Ron');
    this.result = {
      type: tsumo ? 'tsumo' : 'ron', winner: seat, from,
      yaku: w.yaku, han: w.han, fu: w.fu, yakuman: w.yakuman, limit: w.limit, points,
      hand: sortIds(hand), winTile: tileId, melds: p.melds,
      dora: this.doraIndicators(), ura: p.riichi ? this.dead.slice(5, 5 + this.doraCount) : [],
      deltas,
    };
    this.endRound(isDealer);
  }

  exhaustiveDraw() {
    const tenpai = [];
    this.players.forEach((p, s) => {
      // tenpai needs a wait that still exists (a karaten wait is noten)
      if (this.liveWaits(p.hand, p.melds).length) tenpai.push(s);
    });
    const deltas = [0, 0, 0, 0];
    const n = tenpai.length;
    if (n > 0 && n < 4) {
      for (let s = 0; s < 4; s++) deltas[s] = tenpai.includes(s) ? 3000 / n : -3000 / (4 - n);
    }
    this.players.forEach((q, i) => { q.score += deltas[i]; });
    this.announce(this.dealer, 'Ryuukyoku');
    this.result = {
      type: 'draw', tenpai, deltas,
      hands: tenpai.map((s) => ({ seat: s, hand: sortIds(this.players[s].hand), melds: this.players[s].melds })),
    };
    this.endRound(tenpai.includes(this.dealer), true);
  }

  endRound(renchan, draw = false) {
    this.phase = 'end';
    this.claim = null;
    let { round, kyoku, honba } = this;
    honba = renchan || draw ? honba + 1 : 0;
    if (!renchan) { kyoku++; if (kyoku === 4) { kyoku = 0; round++; } }
    // all-last: a dealer who wins while in first place ends the game (agari-yame)
    const allLast = this.round === this.length - 1 && this.kyoku === 3;
    const dealerTop = allLast && renchan && !draw && this.standings()[0].seat === this.dealer;
    const over = this.players.some((p) => p.score < 0) || round >= this.length || dealerTop;
    this.pendingNext = { round, kyoku, honba };
    this.result.gameOver = over;
    this.result.scores = this.players.map((p) => p.score);
    this.log.push({ round: this.round, kyoku: this.kyoku, honba: this.honba, type: this.result.type, winner: this.result.winner, deltas: this.result.deltas });
    this.ready = new Set();
    this.tryAdvance();
  }

  tryAdvance() {
    if (this.phase !== 'end') return;
    const humans = this.players.map((p, i) => i).filter((i) => !this.isBot(i));
    if (humans.some((i) => !this.ready.has(i))) return;
    if (!humans.length && !this.autoAdvance) {
      // all bots: advance after a delay (handled by scheduler)
      return;
    }
    this.advance();
  }

  advance() {
    this.autoAdvance = false;
    if (this.result.gameOver) {
      // leftover riichi sticks go to first place
      const order = this.standings();
      this.players[order[0].seat].score += this.sticks * 1000;
      this.sticks = 0;
      this.phase = 'over';
      this.final = this.standings();
      return;
    }
    Object.assign(this, this.pendingNext);
    this.startRound();
  }

  standings() {
    return this.players.map((p, seat) => ({ seat, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score || a.seat - b.seat);
  }

  /* ---------------- bots / notifications ---------------- */

  changed() {
    this.version++;
    this.onChange(this);
    this.scheduleBots();
  }

  // Stop all bot timers for good (the room drops this game).
  stop() {
    this.stopped = true;
    this.version++;
    this.onChange = () => {};
    if (this.botTimer != null) clearTimeout(this.botTimer);
    this.botTimer = null;
  }

  scheduleBots() {
    const v = this.version;
    if (this.botTimer != null) {
      if (this.botTimerV === v && !this.stopped) return; // already scheduled for this state
      clearTimeout(this.botTimer); // stale: the state changed since
      this.botTimer = null;
    }
    if (this.stopped) return;
    const later = (fn, ms) => {
      this.botTimerV = v;
      this.botTimer = setTimeout(() => { this.botTimer = null; if (this.version === v) fn(); }, ms);
    };
    if (this.phase === 'discard' && this.isBot(this.turn)) {
      const s = this.turn;
      later(() => this.botAct(s), this.botDelay);
    } else if (this.phase === 'claim') {
      const pending = Object.keys(this.claim.opts).map(Number).filter((s) => !this.claim.resp[s] && this.isBot(s));
      if (pending.length) {
        later(() => {
          for (const s of pending) {
            let a = null;
            try { a = botClaim(this, s, this.claim.opts[s]); } catch (e) { console.error('bot claim failed', e); }
            if (!this.setClaimResponse(s, a)) this.setClaimResponse(s, { type: 'pass' });
          }
          this.tryResolveClaim();
          this.changed();
        }, Math.min(this.botDelay, 300));
      }
    } else if (this.phase === 'end') {
      const humans = this.players.some((p) => p.kind !== 'bot');
      if (!humans) later(() => { this.autoAdvance = true; this.advance(); this.changed(); }, this.botDelay * 4);
    }
  }

  // A bot's turn; never stalls the table: an illegal or failed choice falls
  // back to discarding the drawn (or last allowed) tile.
  botAct(s) {
    let a = null;
    try { a = botTurn(this, s); } catch (e) { console.error('bot turn failed', e); }
    if (a && this.act(s, a)) return;
    const o = this.turnOptions(s);
    if (!o) return;
    const p = this.players[s];
    this.act(s, { type: 'discard', tile: o.discard.includes(p.drawn) ? p.drawn : o.discard[o.discard.length - 1] });
  }

  /* ---------------- per-seat view ---------------- */

  view(seat) {
    const me = this.players[seat];
    const showDrawn = this.phase === 'discard' && this.turn === seat && me.drawn != null;
    const claimOpt = this.phase === 'claim' && this.claim.opts[seat] && !this.claim.resp[seat] ? this.claim.opts[seat] : null;
    return {
      phase: this.phase,
      seat,
      round: this.round,
      kyoku: this.kyoku,
      honba: this.honba,
      sticks: this.sticks,
      length: this.length,
      dealer: this.dealer,
      turn: this.turn,
      wall: this.live ? this.live.length : 0,
      dora: this.dead ? this.doraIndicators() : [],
      players: this.players.map((p) => ({
        name: p.name, kind: p.kind, score: p.score, animal: p.animal,
        riichi: p.riichi || p.riichiPending,
        melds: p.melds, discards: p.discards, handCount: p.hand ? p.hand.length : 0,
      })),
      hand: sortIds(showDrawn ? me.hand.filter((id) => id !== me.drawn) : me.hand || []),
      drawn: showDrawn ? me.drawn : null,
      options: this.turnOptions(seat),
      mustDiscard: this.mustDiscard,
      claim: claimOpt ? { tile: this.claim.tile, from: this.claim.from, kind: this.claim.kind, ...claimOpt } : null,
      claimTile: this.phase === 'claim' ? { tile: this.claim.tile, from: this.claim.from } : null,
      lastDiscard: this.lastDiscard,
      waits: me.waits || [],
      furiten: me.waits && me.waits.length ? this.isFuriten(me) : false,
      riichiLocked: me.riichi,
      event: this.event,
      result: this.phase === 'end' || this.phase === 'over' ? this.result : null,
      ready: this.ready ? [...this.ready] : [],
      final: this.phase === 'over' ? this.final : null,
      revealed: this.phase === 'end' || this.phase === 'over' ? this.revealHands() : null,
    };
  }

  // Every seat's concealed hand, for inspecting the table once the hand is over.
  revealHands() {
    return this.players.map((p) => {
      const hand = p.hand || [];
      const drawn = p.drawn != null && hand.includes(p.drawn) && hand.length % 3 === 2 ? p.drawn : null;
      return { hand: sortIds(drawn != null ? hand.filter((id) => id !== drawn) : hand), drawn };
    });
  }
}
