// Table rendering. The game DOM is built once; tile nodes are keyed by tile id
// in one shared Map, so a node can move between hand, pond and meld containers
// and is animated with FLIP (Web Animations API, transform/opacity only).
import { tileType, isRed, doraFromIndicator, WIND_CHARS } from './tiles.js';
import { animalSVG, animalMoves, ANIMAL_NAMES } from './animals.js';

const C = { man: '#c8445f', pin: '#3a6fbf', sou: '#26845b', red: '#e0435f', tile: '#fdf6ee' };
const HONOR_CHAR = ['東', '南', '西', '北', '', '發', '中'];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- tile faces (cached markup) ---------------- */

const PIN = [[[50, 50]], [[50, 28], [50, 72]], [[28, 24], [50, 50], [72, 76]], [[30, 28], [70, 28], [30, 72], [70, 72]],
  [[28, 24], [72, 24], [50, 50], [28, 76], [72, 76]], [[32, 18], [68, 18], [32, 56], [68, 56], [32, 84], [68, 84]],
  [[24, 16], [50, 26], [76, 36], [32, 62], [68, 62], [32, 86], [68, 86]],
  [[32, 14], [68, 14], [32, 38], [68, 38], [32, 62], [68, 62], [32, 86], [68, 86]],
  [[22, 18], [50, 18], [78, 18], [22, 50], [50, 50], [78, 50], [22, 82], [50, 82], [78, 82]]];
const SOU = { 2: [[50, 28], [50, 72]], 3: [[50, 28], [30, 72], [70, 72]], 4: [[30, 28], [70, 28], [30, 72], [70, 72]],
  5: [[26, 28], [74, 28], [50, 50], [26, 72], [74, 72]], 6: [[24, 28], [50, 28], [76, 28], [24, 72], [50, 72], [76, 72]],
  7: [[50, 14], [24, 50], [50, 50], [76, 50], [24, 84], [50, 84], [76, 84]],
  8: [[18, 30], [38, 30], [62, 30], [82, 30], [18, 72], [38, 72], [62, 72], [82, 72]],
  9: [[24, 16], [50, 16], [76, 16], [24, 50], [50, 50], [76, 50], [24, 84], [50, 84], [76, 84]] };
const svg = (body) => `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${body}</svg>`;

function pinSVG(n, red) {
  // Circles use only blue and green: red on a circle tile always means a red five.
  if (n === 1) {
    // 1-pin: a big blue ring around a green ring with a green heart
    return svg(`<circle cx="50" cy="50" r="30" fill="none" stroke="${C.pin}" stroke-width="10"/>`
      + `<circle cx="50" cy="50" r="18" fill="none" stroke="${C.sou}" stroke-width="7"/>`
      + `<circle cx="50" cy="50" r="7" fill="${C.sou}"/>`);
  }
  const r = n <= 4 ? 14 : n <= 6 ? 12 : 10;
  return svg(PIN[n - 1].map(([x, y], i) => {
    // look-alikes stay apart: 6-pin = 2 green over 4 blue, 7-pin = 3 green over 4 blue, 8-pin = all blue
    const c = red && n === 5 ? C.red
      : n === 6 ? (i < 2 ? C.sou : C.pin)
      : n === 7 ? (i < 3 ? C.sou : C.pin)
      : n === 8 ? C.pin
      : (n === 5 && i === 2) ? C.sou : (i % 2 ? C.sou : C.pin);
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${c}" stroke-width="${r * 0.5}"/><circle cx="${x}" cy="${y}" r="${r * 0.32}" fill="${c}"/>`;
  }).join(''));
}

function souSVG(n, red) {
  if (n === 1) {
    return svg(`<ellipse cx="50" cy="42" rx="22" ry="26" fill="${C.sou}"/><circle cx="42" cy="35" r="5" fill="#fff"/><path d="M36 66 L50 90 L64 66Z" fill="${C.man}"/>`);
  }
  const h = n === 7 || n === 9 ? 22 : 30;
  // red sticks as on real tiles: the 5's centre, the 7's top, the 9's centre column; the 6 is all
  // green, so a red column means 9
  // 8-sou: sticks lean into an "M" over a "W" (traditional), so it can't be mistaken for 6-sou
  const SOU8_TILT = [-22, 22, -22, 22, 22, -22, 22, -22];
  return svg(SOU[n].map(([x, y], i) => {
    const c = red && n === 5 ? C.red
      : (n === 9 && i % 3 === 1) || (n === 7 && i === 0) || (n === 5 && i === 2) ? C.man : C.sou;
    const stick = `<rect x="${x - 8}" y="${y - h / 2}" width="16" height="${h}" rx="8" fill="${c}"/><rect x="${x - 9}" y="${y - 1.6}" width="18" height="3.2" rx="1.6" fill="${C.tile}" opacity=".85"/>`;
    return n === 8 ? `<g transform="rotate(${SOU8_TILT[i]} ${x} ${y})">${stick}</g>` : stick;
  }).join(''));
}

// Man numerals: both glyphs are emitted; CSS shows kanji by default, or 1-9 when <html> has .man-arabic.
const MAN_KANJI = '一二三四五六七八九';
const faceCache = new Map();
function faceHTML(t, red) {
  const key = red ? -1 - t : t;
  let f = faceCache.get(key);
  if (f) return f;
  if (t < 9) f = `<span class="f"><em>${MAN_KANJI[t]}</em><b>${t + 1}</b><i>萬</i></span>`;
  else if (t < 18) f = pinSVG(t - 8, red);
  else if (t < 27) f = souSVG(t - 17, red);
  else if (t === 31) f = '<span class="hk"></span>';
  else f = `<span class="h">${HONOR_CHAR[t - 27]}</span>`;
  faceCache.set(key, f);
  return f;
}

function baseClass(id) {
  if (id == null || id < 0) return 'tile back';
  const t = tileType(id);
  const kind = t < 27 ? 'mps'[Math.floor(t / 9)] : t === 31 ? 'haku' : t === 32 ? 'hatsu' : t === 33 ? 'chun' : 'wind';
  return `tile k-${kind}${isRed(id) ? ' red' : ''}`;
}

// doraSet: optional Set of dora tile types; matching tiles get the 'dora' marker class
export function tileHTML(id, cls = '', doraSet = null) {
  if (id == null || id < 0) return `<span class="tile back ${cls}"></span>`;
  if (doraSet && doraSet.has(tileType(id))) cls += ' dora';
  return `<span class="${baseClass(id)} ${cls}">${faceHTML(tileType(id), isRed(id))}</span>`;
}

// tile types that are dora for the given indicator tile ids
export const doraTypes = (indicators) => new Set((indicators || []).map((id) => doraFromIndicator(tileType(id))));

const typeTile = (t, cls = '') => tileHTML(t * 4 + (t === 4 || t === 13 || t === 22 ? 1 : 0), cls);

function meldOrder(m, owner) {
  // returns [[id, mods], ...] in display order
  if (m.type === 'ankan') return m.tiles.map((id, i) => [id, i === 0 || i === 3 ? 'back' : '']);
  const rel = (m.from - owner + 4) % 4; // 3 = left, 2 = across, 1 = right
  const parts = m.tiles.filter((id) => id !== m.called && id !== m.added).map((id) => [id, '']);
  const called = [[m.called, 'side']];
  if (m.added != null) called.push([m.added, 'side']);
  const pos = rel === 3 ? 0 : rel === 2 ? 1 : parts.length;
  parts.splice(pos, 0, ...called);
  return parts;
}

function meldHTML(m, owner, ds = null) {
  return `<span class="meld">${meldOrder(m, owner).map(([id, c]) => (c === 'back' ? tileHTML(null) : tileHTML(id, c, ds))).join('')}</span>`;
}

// Round label in kanji, as on a real table: 東1局, 南3局 …
export function roundName(v) {
  return `${WIND_CHARS[v.round]}${v.kyoku + 1}局`;
}

/* ---------------- action bar / modal markup ---------------- */

export function actionsHTML(v, ui) {
  const b = (act, label, cls = '') => `<button class="act ${cls}" data-act='${esc(JSON.stringify(act))}'>${label}</button>`;
  const out = [];
  let hint = '';
  if (v.claim) {
    const c = v.claim;
    if (c.ron) out.push(b({ type: 'ron' }, 'Ron', 'win'));
    if (c.pon) out.push(b({ type: 'pon' }, 'Pon', 'call'));
    if (c.kan) out.push(b({ type: 'kan' }, 'Kan', 'call'));
    if (c.chi) {
      // each choice shows the whole run it makes: your two tiles (the ones the meld
      // would take: red fives first) plus the called tile, raised and outlined
      for (const pair of c.chi) {
        const used = [];
        const idOf = (t) => {
          const id = (v.hand || []).filter((x) => tileType(x) === t && !used.includes(x)).sort((x, y) => isRed(y) - isRed(x))[0];
          const out = id != null ? id : t * 4 + (t % 9 === 4 ? 1 : 0);
          used.push(out);
          return out;
        };
        const run = [[idOf(pair[0]), ''], [idOf(pair[1]), ''], [c.tile, 'got']].sort((x, y) => tileType(x[0]) - tileType(y[0]));
        out.push(b({ type: 'chi', tiles: pair }, `Chi <span class="mini run">${run.map(([id, cls]) => tileHTML(id, cls)).join('')}</span>`, 'call chi'));
      }
    }
    out.push(b({ type: 'pass' }, 'Pass', 'ghost'));
    hint = `<span class="who">${esc(v.players[c.from].name)}</span> discarded <span class="mini">${tileHTML(c.tile)}</span>`;
  } else if (v.options) {
    const o = v.options;
    if (o.tsumo) out.push(b({ type: 'tsumo' }, 'Tsumo', 'win'));
    if (o.riichi.length) out.push(b({ type: 'ui-riichi' }, ui.riichiMode ? 'Cancel' : 'Riichi', ui.riichiMode ? 'ghost' : 'riichi'));
    for (const t of o.ankan) out.push(b({ type: 'ankan', t }, `Kan <span class="mini">${typeTile(t)}</span>`, 'call'));
    for (const t of o.kakan) out.push(b({ type: 'kakan', t }, `Kan <span class="mini">${typeTile(t)}</span>`, 'call'));
    hint = ui.riichiMode ? 'Riichi! Pick a tile to discard' : (v.riichiLocked ? 'Riichi — auto discard' : 'Your turn');
  } else if (v.phase === 'discard') {
    const off = v.players[v.turn].away === 'gone' && v.players[v.turn].kind !== 'bot';
    hint = `<span><span class="who">${esc(v.players[v.turn].name)}</span>${off ? ' is offline · waiting…' : '\'s turn'}</span>`;
  } else if (v.phase === 'claim') {
    hint = 'Waiting for calls…';
  }
  // a friend lost their connection: the table waits; a majority can let the computer play
  if (!v.claim && !v.options && (v.phase === 'discard' || v.phase === 'claim')) {
    for (const x of v.votes || []) {
      const nm = esc(v.players[x.seat].name);
      out.push(x.mine
        ? `<button class="act ghost" disabled>Voted · ${esc(x.n)}/${esc(x.need)}</button>`
        : b({ type: 'vote-cpu', seat: x.seat }, `Let computer play ${nm}${x.need > 1 ? ` · ${esc(x.n)}/${esc(x.need)}` : ''}`, 'call vote'));
    }
  }
  if (!v.options && v.waits && v.waits.length) {
    hint += `<span class="waits">${v.furiten ? '<em>furiten</em>' : 'waits'} ${v.waits.map((t) => typeTile(t)).join('')}</span>`;
  }
  return { html: out.join(''), hint };
}

function deltasTable(v, r) {
  return `<table class="scores">${v.players.map((p, i) => {
    const d = r.deltas[i];
    return `<tr${i === v.seat ? ' class="me"' : ''}><td class="w">${WIND_CHARS[(i - v.dealer + 4) % 4]}</td><td class="nm">${esc(p.name)}</td><td class="num">${esc(r.scores[i])}</td>
      <td class="num ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}">${d > 0 ? '+' : ''}${esc(d || '')}</td></tr>`;
  }).join('')}</table>`;
}

export function resultKey(v) {
  if (v.phase === 'over') return `over:${v.isHost ? 1 : 0}`;
  if (!v.result) return '';
  const r = v.result;
  return `${v.round}:${v.kyoku}:${v.honba}:${r.type}:${r.winner}:${v.ready.join(',')}`;
}

// closes the card to look at the table with every hand revealed (handled in Table, not main.js)
const PEEK_BTN = '<button class="act ghost peekbtn" data-ui="close" title="Close and look at the table (Esc)">View table</button>';

const miniAnimal = (p) => (p && p.animal != null ? `<span class="ani">${animalSVG(p.animal)}</span>` : '');

// Honba and riichi sticks drawn like on a real table: a 100-point stick (a column of
// dots) per honba, a 1000-point stick (one red dot) per riichi deposit.
const STICK = { honba: '<i class="stk s100" aria-hidden="true"></i>', riichi: '<i class="stk s1000" aria-hidden="true"></i>' };
const stickGrp = (kind, n, pts) => `<span class="grp">${kind} ${STICK[kind]}${n > 1 ? `×${n}` : ''}${pts ? ` ${pts}` : ''}</span>`;
// in the center box during a hand: only the sticks on the table
function sticksHTML(v) {
  const honba = Math.max(0, v.honba | 0), sticks = Math.max(0, v.sticks | 0);
  if (!honba && !sticks) return '';
  const g = (kind, n) => `<span class="grp" title="${n} ${kind}">${STICK[kind]}×${n}</span>`;
  return `<span class="sticks">${honba ? g('honba', honba) : ''}${sticks ? g('riichi', sticks) : ''}</span>`;
}
// on the result card, after the hand's points: what the winner got on top
function extrasHTML(r) {
  const honba = Math.max(0, r.honba | 0), sticks = Math.max(0, r.sticks | 0);
  if (!honba && !sticks) return '';
  return `<span class="extra">${honba ? stickGrp('honba', honba, 300 * honba) : ''}${sticks ? stickGrp('riichi', sticks, 1000 * sticks) : ''}</span>`;
}

// One line under the scores: what comes next, or why the game is over.
function nextLine(v, r) {
  if (r.gameOver) {
    const why = r.endReason === 'bust' ? `${esc(v.players[r.scores.findIndex((x) => x < 0)].name)} dropped below zero`
      : r.endReason === 'agari-yame' ? 'the dealer won the last hand in first place (agari-yame)' : 'that was the last hand';
    return `<p class="nextline">Game over: ${why}</p>`;
  }
  const n = r.next;
  if (!n) return '';
  const what = `${WIND_CHARS[n.round]}${n.kyoku + 1}局${n.honba ? ` · ${n.honba} honba` : ''}`;
  return `<p class="nextline">Next: <b>${esc(what)}</b>${n.renchan ? ' · the dealer stays' : ''}</p>`;
}

export function resultHTML(v) {
  const r = v.result;
  if (v.phase === 'over') {
    const rows = v.final.map((f, i) => `<tr${f.seat === v.seat ? ' class="me"' : ''}><td class="rank">${i + 1}</td><td class="nm">${miniAnimal(v.players[f.seat])}${esc(f.name)}</td><td class="num">${esc(f.score)}</td></tr>`).join('');
    return `<div class="res over"><h2 class="big">Game over</h2><table class="scores final">${rows}</table>${r ? nextLine(v, r) : ''}
      <div class="btns">${v.isHost
        ? '<button class="act hot wide" data-act=\'{"type":"ui-again"}\'>Play again</button><button class="act ghost wide" data-act=\'{"type":"ui-lobby"}\'>Back to lobby</button>'
        : '<p class="muted wait">Waiting for the host to play again…</p>'}
      ${PEEK_BTN.replace('class="act ghost', 'class="act ghost wide')}<button class="act ghost wide" data-act='{"type":"ui-leave"}'>Leave</button></div></div>`;
  }
  // .res is a grid on short landscape screens: hand + yaku left, scores + button right (see style.css)
  let body;
  const ds = doraTypes(r.dora || v.dora); // ura indicators are not dora here
  if (r.type === 'draw') {
    body = `<h2>Ryuukyoku <small>exhaustive draw</small></h2>
      <div class="rhands">${r.tenpai.length ? r.hands.map((h) => `<div class="rhand"><div class="who">${esc(v.players[h.seat].name)} — tenpai</div>
        ${h.hand.map((id) => tileHTML(id, '', ds)).join('')}${h.melds.map((m) => meldHTML(m, h.seat, ds)).join('')}</div>`).join('') : '<p class="muted">Nobody was tenpai</p>'}</div>`;
  } else {
    const w = v.players[r.winner];
    const how = r.type === 'tsumo' ? (r.winner === v.seat ? 'you won!' : '') : `from ${esc(v.players[r.from].name)}`;
    body = `<h2><span class="badge ${r.type}">${r.type === 'tsumo' ? 'Tsumo' : 'Ron'}</span> ${esc(w.name)} <small>${how}</small></h2>
      <div class="rhand">${r.hand.map((id) => tileHTML(id, '', ds)).join('')}<span class="gap"></span>${tileHTML(r.winTile, 'win', ds)}
        ${r.melds.map((m) => meldHTML(m, r.winner, ds)).join('')}</div>
      <div class="indic">Dora ${r.dora.map((id) => tileHTML(id)).join('')}${r.ura.length ? `<span class="sep"></span>Ura ${r.ura.map((id) => tileHTML(id)).join('')}` : ''}</div>
      <ul class="yaku${r.yaku.length > 3 ? ' two' : ''}">${r.yaku.map(([n, h]) => `<li><span>${esc(n)}</span><span>${r.yakuman ? '' : esc(h) + ' han'}</span></li>`).join('')}</ul>
      <div class="total">${r.yakuman ? '' : `${esc(r.han)} han ${esc(r.fu)} fu`} ${r.limit ? `<b>${esc(r.limit)}</b>` : ''} · <b>${esc(r.points)}</b>${extrasHTML(r)}</div>`;
  }
  const readyNames = v.ready.map((s) => esc(v.players[s].name));
  const iAmReady = v.ready.includes(v.seat);
  return `<div class="res ${r.type === 'draw' ? 'draw' : 'win'}">${body}${deltasTable(v, r)}${nextLine(v, r)}
    <div class="gorow">${PEEK_BTN}${iAmReady ? `<p class="muted wait">Waiting for others…${readyNames.length ? ' (ready: ' + readyNames.join(', ') + ')' : ''}</p>`
    : `<button class="act hot wide go" data-act='{"type":"ready"}'>${r.gameOver ? 'See results' : 'Next hand'}</button>`}</div></div>`;
}

// While the result card is closed to look at the table: reopen it, or say ready from here.
export function peekActions(v) {
  const over = v.phase === 'over';
  const iAmReady = v.ready.includes(v.seat);
  const out = [`<button class="act ghost reopen" data-ui="open">${over ? 'Standings' : 'Show results'}</button>`];
  if (!over && !iAmReady) out.push(`<button class="act hot" data-act='{"type":"ready"}'>${v.result.gameOver ? 'See results' : 'Next hand'}</button>`);
  const hint = over ? 'Game over · final table' : iAmReady ? 'Waiting for others…' : 'Hand over · all hands shown';
  return { html: out.join(''), hint };
}

// Right after the end-of-hand celebration: the table stays (all hands shown) and one
// highlighted button opens the result card, so the switch happens when you are ready.
export function afterCelebActions(v) {
  const r = v.result;
  const name = (s) => esc(v.players[s] ? v.players[s].name : '');
  const hint = r.type === 'draw' ? 'Ryuukyoku · draw'
    : `${r.winner === v.seat ? 'You win' : `${name(r.winner)} wins`} · ${r.type === 'tsumo' ? 'tsumo' : `ron${r.from != null && r.from >= 0 ? ` from ${r.from === v.seat ? 'you' : name(r.from)}` : ''}`}`;
  return { html: '<button class="act hot reveal" data-ui="open">Show results</button>', hint };
}

let current = null; // the live Table, for Escape
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !current) return;
  const menu = document.getElementById('menu');
  if (menu && !menu.hidden) return; // main.js closes the menu first
  if (current.celeb) { current.endCeleb(true); return; }
  if (current.resKey && !current.peek) current.setPeek(true);
});

/* ---------------- keyed table ---------------- */

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const EASE = 'cubic-bezier(.22,1,.36,1)';
const ANGLES = [0, -90, 180, 90]; // rotation of layer r0..r3

function setText(el, s) { s = String(s); if (el._t !== s) { el._t = s; el.textContent = s; } }
function setCls(el, c) { if (el.className !== c) el.className = c; }
// restart a CSS entry animation (.in) on an element
function replayIn(el) { el.classList.remove('in'); void el.offsetWidth; el.classList.add('in'); }

/* Mascot emotes: a tap or swipe on your own mascot (see Table.setupEmotes) plays on
   that player's mascot on every screen (main.js relays them through the session).
   The face variant comes from js/animals.js, the moves and effects from style.css. */
export const EMOTE_TEXT = { go: 'He he, let\'s go!', hurray: 'Hurray!', sad: 'Aww…', 'think-left': 'Hmm…', 'think-right': 'Hmm…',
  angry: 'Kono yaro ><',
  // local only (the end-of-hand celebration; the room relays only the five above)
  'pat-left': 'Pat pat', 'pat-right': 'Pat pat' };
const EMOTE_MS = 1800;
const SWIPE_MIN = 24; // px along the dominant axis
const TAP_MAX = 12; // px: a press that moved less is a tap

/* Away mascots, from view.players[i]. .gone: a friend lost their connection; the
   mascot hides behind two tile backs (only the top of the head peeks out). .sleep: the
   table has waited on them for 45 s (room.js SLEEP_MS); eyes shut, slow breathing,
   floating z's, until they touch the screen. */
const AWAY_FX = { gone: '<span class="hide" aria-hidden="true"><i></i><i></i></span>', sleep: '<span class="zz" aria-hidden="true"><i>z</i><i>z</i><i>z</i></span>' };
export const awayOf = (p) => (!p ? null : p.away === 'gone' ? 'gone' : p.sleep ? 'sleep' : null);
// set a mascot box's away state ('gone' | 'sleep' | null): class plus the extra markup
export function setAway(el, away) {
  away = AWAY_FX[away] ? away : null;
  if (!el || (el._away || null) === away) return;
  el._away = away;
  for (const x of el.querySelectorAll('.hide, .zz')) x.remove();
  el.classList.remove('gone', 'sleep');
  if (!away) return;
  if (el._emo) { clearTimeout(el._emoT); el.classList.remove('emo', 'emo-' + el._emo); for (const x of el.querySelectorAll('.emo-fx, .bub')) x.remove(); el._emo = null; }
  el.classList.remove('idle');
  el.classList.add(away);
  el.insertAdjacentHTML('beforeend', AWAY_FX[away]);
}
const STAR = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 0Q5.6 4.4 10 5Q5.6 5.6 5 10Q4.4 5.6 0 5Q4.4 4.4 5 0Z"/></svg>';
const HEART = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 9C1.6 6.6 0 5 0 3.1 0 1.4 1.3.3 2.7.3 3.7.3 4.5.9 5 1.7 5.5.9 6.3.3 7.3.3 8.7.3 10 1.4 10 3.1 10 5 8.4 6.6 5 9Z"/></svg>';
const PAW = '<svg viewBox="0 0 20 20" aria-hidden="true"><ellipse cx="10" cy="13" rx="5.2" ry="4.4"/><circle cx="4" cy="7.6" r="2.1"/><circle cx="8" cy="4.6" r="2.2"/><circle cx="12.4" cy="4.6" r="2.2"/><circle cx="16.2" cy="7.6" r="2.1"/></svg>';
const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('');
const EMOTE_FX = {
  go: rep(3, () => `<i class="sp">${STAR}</i>`),
  hurray: rep(8, () => '<i class="cf"></i>') + rep(2, () => `<i class="st">${STAR}</i>`),
  sad: rep(3, () => '<i class="gl"></i>'),
  'think-left': '<i class="qm">?</i>',
  'think-right': '<i class="qm">?</i>',
  // an anger mark (four red curls) by the head, and two puffs of steam
  angry: '<i class="vein"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 8.2Q8.2 8.2 8.2 3M11.8 3Q11.8 8.2 17 8.2M17 11.8Q11.8 11.8 11.8 17M8.2 17Q8.2 11.8 3 11.8"/></svg></i><i class="puff"></i><i class="puff"></i>',
  'pat-left': rep(2, () => `<i class="ht">${HEART}</i>`),
  'pat-right': rep(2, () => `<i class="ht">${HEART}</i>`),
};
// the emote markup inside a mascot's .ani box: effects plus a bubble with the words
// (text: other words in the bubble, e.g. "Ron!" at the end of a hand)
export function emoteHTML(kind, text = EMOTE_TEXT[kind]) {
  const think = kind === 'think-left' || kind === 'think-right' || kind === 'pat-left' || kind === 'pat-right';
  return `<span class="emo-fx" aria-hidden="true">${EMOTE_FX[kind] || ''}</span><span class="bub${think ? ' think' : ''}">${esc(text)}</span>`;
}
// Show an emote on a mascot box (.ani on the table, .mav in the lobby) for EMOTE_MS:
// classes .emo .emo-<kind> drive the face and moves, plus effects and a bubble.
export function playEmoteOn(el, kind, text) {
  if (!el || !el.firstChild || !EMOTE_TEXT[kind] || el.classList.contains('gone') || el.classList.contains('sleep')) return;
  clearTimeout(el._emoT);
  for (const x of el.querySelectorAll('.emo-fx, .bub')) x.remove();
  el.classList.remove('emo');
  if (el._emo) el.classList.remove('emo-' + el._emo);
  void el.offsetWidth; // restart the animations
  el._emo = kind;
  el.insertAdjacentHTML('beforeend', emoteHTML(kind, text));
  el.classList.add('emo', 'emo-' + kind);
  // keep the bubble on screen: nudge it sideways (its tail stays on the mascot)
  const bub = el.lastElementChild;
  const pr = el.getBoundingClientRect();
  const left = pr.left + bub.offsetLeft, right = left + bub.offsetWidth, pad = 6;
  const dx = left < pad ? pad - left : right > innerWidth - pad ? innerWidth - pad - right : 0;
  if (dx) { bub.style.translate = `${Math.round(dx)}px 0`; bub.style.setProperty('--tx', `${Math.round(Math.max(-(bub.offsetWidth - 26), Math.min(bub.offsetWidth - 26, -dx)))}px`); }
  el._emoT = setTimeout(() => {
    el.classList.remove('emo', 'emo-' + kind);
    for (const x of el.querySelectorAll('.emo-fx, .bub')) x.remove();
    el._emo = null;
  }, EMOTE_MS);
}

// Pointer gestures on a mascot element: onKind(kind) after a tap or swipe. Returns
// nothing; listeners go away with signal.
export function emoteGestures(el, onKind, signal) {
  let g = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault(); // no text selection or native drag
    g = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  }, { signal });
  el.addEventListener('pointerup', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const kind = gestureEmote(e.clientX - g.x, e.clientY - g.y);
    g = null;
    if (kind) onKind(kind, e);
  }, { signal });
  el.addEventListener('pointercancel', (e) => { if (g && e.pointerId === g.id) g = null; }, { signal });
  el.addEventListener('contextmenu', (e) => e.preventDefault(), { signal }); // long press
}

// what a pointer gesture means: a tap, a swipe (dominant axis, at least SWIPE_MIN px) or nothing
export function gestureEmote(dx, dy) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (Math.max(ax, ay) < SWIPE_MIN) return ax < TAP_MAX && ay < TAP_MAX ? 'go' : null;
  if (ay >= ax) return dy < 0 ? 'hurray' : 'sad';
  return dx < 0 ? 'think-left' : 'angry';
}

/* End-of-hand celebration: before the result card, a banner on the table ("Tsumo!",
   "Ron!" or "Ryuukyoku") with the winning tile, confetti or soft rain, and every seat's
   mascot reacting with a local emote. Plays once per hand end, only when this table
   saw the hand being played (not after a reload straight into the result). A tap or
   Escape skips to the card. Motion is in style.css (#celeb); reduced motion: a fade. */
const CELEB_MS = { win: 2600, limit: 2900, draw: 2300, reduced: 1300 };
const CONFETTI = ['#ff8fab', '#7fd6ff', '#a8e68f', '#ffd35c', '#c9a7ff', '#ffb46b'];
const SEAT_DIR = [[0, 1], [1, 0], [0, -1], [-1, 0]]; // toward seat r from the center
const fx = (n) => n.toFixed(2);

function celebHTML(v) {
  const r = v.result;
  if (r.type === 'draw') {
    const n = r.tenpai.length;
    const sub = n === 0 ? 'Nobody tenpai' : n === 4 ? 'Everyone tenpai' : `${n} tenpai`;
    const rain = rep(16, (i) => `<i style="--x:${fx((i / 15 - 0.5) * 1.5 + (Math.random() - 0.5) * 0.06)};--d:${Math.round(Math.random() * 900)}ms;--l:${fx(0.6 + Math.random() * 0.6)}"></i>`);
    return `<div class="cb draw"><div class="cb-dim" aria-hidden="true"></div><div class="cb-rain" aria-hidden="true">${rain}</div>
      <div class="cb-banner"><div class="cb-big">Ryuukyoku</div><div class="cb-sub">Exhaustive draw · ${sub}</div></div></div>`;
  }
  const w = v.players[r.winner];
  const rel = (r.winner - v.seat + 4) % 4;
  const [dx, dy] = SEAT_DIR[rel];
  const big = r.yakuman ? ' yakuman' : r.limit ? ' limit' : '';
  const n = big ? 34 : 24;
  const conf = rep(n, (i) => {
    const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
    const d = 0.28 + Math.random() * 0.22;
    return `<i class="${i % 3 ? '' : 'rd'}" style="--x:${fx(Math.cos(a) * d * 1.25)};--y:${fx(Math.sin(a) * d - 0.08)};--r:${Math.round((Math.random() - 0.5) * 720)}deg;--d:${Math.round(Math.random() * 160)}ms;--c:${CONFETTI[i % CONFETTI.length]}"></i>`;
  });
  const ns = big ? 10 : 6;
  const stars = rep(ns, (i) => {
    const a = (i / ns) * Math.PI * 2 + 0.4;
    return `<i style="--x:${fx(Math.cos(a) * 0.34)};--y:${fx(Math.sin(a) * 0.2)};--d:${180 + i * 110}ms">${STAR}</i>`;
  });
  const from = r.type === 'ron' ? `<span class="cb-from">from ${esc(v.players[r.from].name)}</span>` : '';
  const ani = w.animal != null ? `<span class="cb-ani">${animalSVG(w.animal)}</span>` : '';
  return `<div class="cb win ${r.type}${big}"><div class="cb-dim" aria-hidden="true"></div>
    ${big ? '<div class="cb-rays" aria-hidden="true"></div>' : ''}<div class="cb-glow" aria-hidden="true"></div>
    <div class="cb-conf" aria-hidden="true">${conf}</div><div class="cb-stars" aria-hidden="true">${stars}</div>
    <div class="cb-banner">
      <div class="cb-tile" style="--fx:${dx};--fy:${dy}" aria-hidden="true">${tileHTML(r.winTile)}</div>
      <div class="cb-big">${r.type === 'tsumo' ? 'Tsumo!' : 'Ron!'}</div>
      <div class="cb-sub">${ani}<span class="cb-name">${esc(w.name)}</span>${from}</div>
      ${r.limit ? `<div class="cb-limit">${esc(r.limit)}!</div>` : ''}
    </div></div>`;
}

const TABLE_HTML = `
  <div id="table"><div id="wrap"><div id="board">
    <div class="center"><div class="round"></div><div class="sub"></div><div class="dora"></div></div>
    <div id="celeb" role="status"></div>
    ${[0, 1, 2, 3].map((r) => `<span class="ani a${r}${r ? '' : ' me'}"></span>`).join('')}
    ${[0, 1, 2, 3].map((r) => `<div class="layer r${r}">
      <div class="info"><div class="txt"><span class="wind"></span><span class="score"></span><span class="stick" hidden></span><span class="pname"></span></div></div>
      <div class="pond"></div>
      <div class="edge"><span class="backs"></span><span class="melds"></span></div>
    </div>`).join('')}
  </div><div id="announce"></div></div></div>
  <div id="bar">
    <div id="status"><span id="hint"></span><span id="actions"></span></div>
    <div id="hand"><div class="handrow"><span class="tiles"></span><span class="drawn"></span><span class="mymelds"></span></div></div>
  </div>
  <div id="celebskip" hidden></div>
  <div id="modal" role="dialog" aria-modal="true" aria-label="Hand result" hidden><div class="card" id="modalcard"></div></div>`;

export class Table {
  constructor(root) {
    this.root = root;
    // key -> tile element ('t'+id for faces, 'h'+seat+':'+i for hidden backs).
    // Bounded: at most 136 faces + 4 x 14 backs, reused across hands.
    this.nodes = new Map();
    this.anims = new Set();
    this.dealKey = null;
    this.evId = 0;
    this.actKey = null;
    this.resKey = null;
    this.doraSet = new Set(); // tile types that are currently dora (marked with .dora)
    this.peek = false; // result card closed to look at the revealed table
    this.celebWait = false; // peeking right after the celebration: one "Show results" button
    this.off = new AbortController(); // removes our listeners in destroy()
    root.innerHTML = TABLE_HTML;
    const q = (s) => root.querySelector(s);
    this.el = {
      round: q('.center .round'), sub: q('.center .sub'), dora: q('.center .dora'),
      announce: q('#announce'), hint: q('#hint'), actions: q('#actions'), bar: q('#bar'),
      hand: q('#hand .tiles'), drawn: q('#hand .drawn'), mymelds: q('#hand .mymelds'),
      modal: q('#modal'), modalcard: q('#modalcard'), celeb: q('#celeb'), celebskip: q('#celebskip'),
    };
    this.celeb = null; // the end-of-hand celebration playing: { key, timers }
    this.celebKey = null; // the last hand end seen (celebrated or not)
    this.playKey = null; // the hand this table saw being played
    this.el.celebskip.addEventListener('click', (e) => { e.stopPropagation(); this.endCeleb(true); }, { signal: this.off.signal });
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ui]');
      if (b && b.dataset.ui === 'close') this.setPeek(true);
      else if (b && b.dataset.ui === 'open') this.setPeek(false);
      else if (e.target === this.el.modal && this.resKey) this.setPeek(true); // tap on the backdrop
    }, { signal: this.off.signal });
    this.anis = [0, 1, 2, 3].map((r) => q(`.ani.a${r}`));
    this.idleTimer = null;
    this.idleEnd = null;
    this.scheduleIdle();
    this.onEmote = null; // (kind) => void: set by main.js; your gesture on your mascot
    this.mine = []; // your own emotes played before the room's echo: [{ kind, at }]
    this.setupEmotes();
    this.layers = [0, 1, 2, 3].map((r) => {
      const L = q(`.layer.r${r}`);
      const o = {
        info: L.querySelector('.info'), wind: L.querySelector('.wind'), score: L.querySelector('.score'),
        stick: L.querySelector('.stick'), pname: L.querySelector('.pname'),
        pond: L.querySelector('.pond'), backs: L.querySelector('.backs'), melds: L.querySelector('.melds'),
      };
      o.pond._ang = o.backs._ang = o.melds._ang = ANGLES[r];
      return o;
    });
    this.el.hand._ang = this.el.drawn._ang = this.el.mymelds._ang = 0;
    this.el.handbox = q('#hand');
    this.el.handrow = q('#hand .handrow');
    // unlocked tiles (ui.free): your own order of hand ids, client-side only
    this.order = null;
    this.drag = null;
    this.setupDrag();
    current = this;
  }

  // The screen is leaving the table: drop listeners, animations and tile nodes.
  destroy() {
    this.off.abort();
    clearTimeout(this.idleTimer);
    clearTimeout(this.idleEnd);
    for (const el of this.anis) clearTimeout(el._emoT);
    if (this.celeb) for (const t of this.celeb.timers) clearTimeout(t);
    this.celeb = null;
    this.idleTimer = this.idleEnd = null;
    this.drag = null;
    for (const a of this.anims) a.cancel();
    this.anims.clear();
    this.nodes.clear();
    this.v = null;
    if (current === this) current = null;
  }

  /* ---- your animal: an idle move every 6-15 s; emotes from a tap or swipe ---- */
  scheduleIdle() {
    clearTimeout(this.idleTimer);
    if (this.off.signal.aborted) return;
    this.idleTimer = setTimeout(() => {
      if (!reduceMotion.matches && !document.hidden && !this.anis[0]._emo && !this.anis[0]._away) {
        const moves = animalMoves(this.anis[0]._k);
        this.animalMove(moves[Math.floor(Math.random() * moves.length)]);
      }
      this.scheduleIdle();
    }, 6000 + Math.random() * 9000);
  }

  // move: an idle move name (data-move); restarts the CSS animation
  animalMove(move) {
    const el = this.anis[0];
    if (!el.firstChild || this.off.signal.aborted || el._emo) return; // let an emote finish
    clearTimeout(this.idleEnd);
    el.classList.remove('idle');
    void el.offsetWidth;
    el.dataset.move = move;
    el.classList.add('idle');
    this.idleEnd = setTimeout(() => el.classList.remove('idle'), 1400);
  }

  // Gestures on your own mascot: tap = go, swipe up = hurray, down = sad,
  // left = think-left, right = angry. Pointer events, so mouse and touch
  // both work; touch-action: none (style.css) keeps the page from scrolling.
  setupEmotes() {
    emoteGestures(this.anis[0], (kind) => { if (this.onEmote) this.onEmote(kind); }, this.off.signal);
  }

  // Play an emote on a seat's mascot. own: your gesture, played before the room's echo.
  // Returns false when it was the echo of one already shown.
  emote(seat, kind, own = false) {
    if (!this.v || !EMOTE_TEXT[kind] || this.off.signal.aborted) return false;
    const r = (seat - this.v.seat + 4) % 4;
    const now = Date.now();
    this.mine = this.mine.filter((m) => now - m.at < 4000);
    if (!own && this.anis[r]._celeb > now) return false; // its end-of-hand reaction is showing
    if (own) this.mine.push({ kind, at: now });
    else if (r === 0) {
      const i = this.mine.findIndex((m) => m.kind === kind);
      if (i >= 0) { this.mine.splice(i, 1); return false; } // our own, already shown
    }
    this.playEmote(r, kind);
    return true;
  }

  get emoting() { return !!this.anis[0]._emo; }

  playEmote(r, kind, text) {
    if (r === 0) { clearTimeout(this.idleEnd); this.anis[0].classList.remove('idle'); }
    playEmoteOn(this.anis[r], kind, text);
  }

  /* ---- end-of-hand celebration (see celebHTML) ---- */
  // Called on every update: starts it on a fresh hand end, stops it when the view moved on.
  checkCeleb(v) {
    const r = v.result;
    const hand = `${v.round}:${v.kyoku}:${v.honba}`;
    if (v.phase !== 'end' && v.phase !== 'over') { this.playKey = hand; this.celebKey = null; }
    const key = v.phase === 'end' && r ? `${hand}:${r.type}:${r.winner ?? ''}` : '';
    if (this.celeb && this.celeb.key !== key) this.endCeleb(false);
    if (!key || key === this.celebKey) return;
    this.celebKey = key;
    // a reload or reconnect straight into the result: just the card
    if (this.playKey !== hand || document.hidden) return;
    this.startCeleb(v, key);
  }

  startCeleb(v, key) {
    const r = v.result;
    const reduced = reduceMotion.matches;
    const ms = reduced ? CELEB_MS.reduced : r.type === 'draw' ? CELEB_MS.draw : r.limit ? CELEB_MS.limit : CELEB_MS.win;
    const timers = [];
    this.celeb = { key, timers };
    this.el.celeb.innerHTML = celebHTML(v);
    this.el.celebskip.hidden = false;
    this.el.announce.replaceChildren(); // e.g. a "Riichi!" still showing
    const rel = (s) => (s - v.seat + 4) % 4;
    const rnd = (a, b) => a + Math.random() * (b - a);
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    const emo = (s, kind, text, at) => timers.push(setTimeout(() => {
      if (!this.celeb || this.celeb.key !== key) return;
      this.playEmote(rel(s), kind, text);
      this.anis[rel(s)]._celeb = Date.now() + EMOTE_MS; // others' emotes wait (see emote)
    }, at));
    if (r.type === 'draw') {
      for (let s = 0; s < 4; s++) {
        const t0 = 240 + rel(s) * 90 + rnd(0, 120);
        if (r.tenpai.includes(s)) {
          emo(s, 'go', 'Tenpai!', t0);
          if (Math.random() < 0.5) emo(s, pick(['go', 'hurray']), pick(['Phew!', 'Yay!']), t0 + rnd(1000, 1300));
        } else {
          emo(s, 'sad', 'Noten…', t0);
          if (Math.random() < 0.4) emo(s, pick(['think-left', 'think-right']), pick(['Hmm…', 'So close…']), t0 + rnd(1100, 1400));
        }
      }
    } else {
      // (head-bump: one winner; a list is handled the same way should it ever come)
      const winners = Array.isArray(r.winners) && r.winners.length ? r.winners : [r.winner];
      const word = r.type === 'tsumo' ? 'Tsumo!' : 'Ron!';
      const loser = r.type === 'ron' ? r.from : -1;
      // look toward the loser: by screen side (a0/a3 left, a1/a2 right); same side: inward
      const side = (q) => (q === 0 || q === 3 ? -1 : 1);
      const toward = (s) => {
        const d = side(rel(loser)) - side(rel(s));
        return (d ? d < 0 : side(rel(s)) > 0) ? 'left' : 'right';
      };
      for (let s = 0; s < 4; s++) {
        if (winners.includes(s)) {
          // happy first and last: a second hurray holds it until the card
          emo(s, 'hurray', word, 180);
          emo(s, 'hurray', pick(['Yay!', word, 'Woohoo!']), 1250);
        } else if (s === loser) {
          emo(s, 'sad', 'Aww…', 480);
        } else if (r.type === 'tsumo') {
          const t0 = rnd(380, 700);
          emo(s, 'go', pick(['Nice!', 'Yay!', 'Wow!', 'Good one!']), t0);
          if (Math.random() < 0.55) emo(s, pick(['go', 'hurray']), pick(['Clap clap!', 'Hehe!', 'Yay!']), t0 + rnd(950, 1250));
        } else {
          // bystanders of a ron: look at the loser, then comfort them
          const dir = toward(s);
          const t0 = rnd(420, 650);
          if (Math.random() < 0.7) emo(s, 'think-' + dir, pick(['Oh no…', 'Oof…', 'Hmm…']), t0);
          const tp = t0 + rnd(650, 900);
          emo(s, 'pat-' + dir, pick(['Pat pat', 'There there', '♥']), tp);
          timers.push(setTimeout(() => { if (this.celeb && this.celeb.key === key) this.patOn(rel(loser)); }, tp + 260));
        }
      }
    }
    timers.push(setTimeout(() => this.endCeleb('wait'), ms));
  }

  // a comforting paw patting the loser's head, with little hearts
  patOn(r) {
    const el = this.anis[r];
    if (!el.firstChild) return;
    const old = el.querySelector('.cb-pat');
    if (old) old.remove();
    el.insertAdjacentHTML('beforeend', `<span class="cb-pat" aria-hidden="true"><i class="pw">${PAW}</i>${rep(3, () => `<i class="ht">${HEART}</i>`)}</span>`);
    const p = el.lastElementChild;
    if (this.celeb) this.celeb.timers.push(setTimeout(() => p.remove(), 1500));
  }

  // show: true opens the result card (skipped); 'wait' (finished) keeps the table with a
  // "Show results" button (afterCelebActions); false: the view moved on
  endCeleb(show) {
    if (!this.celeb) return;
    for (const t of this.celeb.timers) clearTimeout(t);
    for (const p of this.root.querySelectorAll('.cb-pat')) p.remove();
    this.celeb = null;
    this.el.celeb.replaceChildren();
    this.el.celebskip.hidden = true;
    if (show === 'wait' && this.v && !this.off.signal.aborted) {
      this.peek = true;
      this.celebWait = true;
      this.update(this.v, this.ui);
      const b = this.el.actions.querySelector('.reveal');
      if (b && matchMedia('(pointer: fine)').matches) b.focus({ preventScroll: true });
    } else if (show && this.v && !this.off.signal.aborted) {
      this.update(this.v, this.ui);
      if (this.resKey && !this.peek) this.showModal();
    }
  }

  patchAnimal(r, p) {
    const el = this.anis[r];
    if (el._k === p.animal) return;
    el._k = p.animal;
    clearTimeout(el._emoT);
    if (el._emo) el.classList.remove('emo', 'emo-' + el._emo);
    el._emo = null;
    el._away = null;
    el.classList.remove('gone', 'sleep');
    el.innerHTML = p.animal == null ? '' : animalSVG(p.animal);
    el.title = p.animal == null ? '' : ANIMAL_NAMES[p.animal % ANIMAL_NAMES.length];
  }

  setPeek(on) {
    if (!this.v || this.peek === on) return;
    this.peek = on;
    this.update(this.v, this.ui);
    if (!on) this.showModal();
  }

  showModal() {
    replayIn(this.el.modal);
    const go = this.el.modalcard.querySelector('.go');
    if (go) go.focus({ preventScroll: true });
  }

  node(key, id) {
    let el = this.nodes.get(key);
    if (!el) {
      const t = document.createElement('template');
      t.innerHTML = tileHTML(id);
      el = t.content.firstChild;
      el._base = baseClass(id);
      el._type = id == null || id < 0 ? -1 : tileType(id);
      if (id != null) el.dataset.id = id;
      this.nodes.set(key, el);
    }
    return el;
  }

  // put exactly `list` ([el, mods]) into container, in order
  place(box, list) {
    let i = 0;
    for (const [el, mods] of list) {
      const base = this.doraSet.has(el._type) ? `${el._base} dora` : el._base;
      setCls(el, mods ? `${base} ${mods}` : base);
      el._ang = box._ang;
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
      i++;
    }
    while (box.children.length > i) box.lastChild.remove();
  }

  placeMelds(box, melds, owner) {
    while (box.children.length > melds.length) box.lastChild.remove();
    melds.forEach((m, i) => {
      let span = box.children[i];
      if (!span) { span = document.createElement('span'); span.className = 'meld'; box.appendChild(span); }
      span._ang = box._ang;
      this.place(span, meldOrder(m, owner).map(([id, c]) => [this.node('t' + id, id), c]));
    });
  }

  update(v, ui) {
    this.v = v;
    this.ui = ui;
    const dealKey = `${v.round}:${v.kyoku}:${v.honba}:${v.dora.length ? v.dora[0] : ''}`;
    const animate = this.dealKey === dealKey && !reduceMotion.matches && !document.hidden && typeof Element.prototype.animate === 'function';
    if (this.dealKey !== dealKey) { this.order = null; this.endDrag(false, true); } // a new deal: back to the dealt order
    this.dealKey = dealKey;

    // FIRST: where every connected tile is now (mid-animation positions included)
    const before = animate ? this.measure(v.seat) : null;
    if (this.settleDrag) { this.settleDrag(); this.settleDrag = null; } // a drop: clear the drag offsets after FIRST
    for (const a of this.anims) a.cancel();
    this.anims.clear();

    this.checkCeleb(v);
    this.patchCenter(v);
    const newPond = new Set(); // elements newly added to a pond
    for (let r = 0; r < 4; r++) this.patchSeat(v, r, newPond);
    this.patchHand(v, ui);
    const rk = resultKey(v);
    this.patchBar(v, ui, rk);
    const event = this.patchEvent(v);
    this.patchModal(v, rk);

    // LAST + INVERT + PLAY
    if (before) this.flip(before, newPond);
    return { event };
  }

  measure(me) {
    const rects = new Map();
    for (const el of this.nodes.values()) if (el.isConnected) rects.set(el, { r: el.getBoundingClientRect(), a: el._ang });
    const lastBack = [];
    for (let r = 1; r < 4; r++) {
      const b = this.layers[r].backs.lastElementChild;
      if (b) lastBack[(me + r) % 4] = b.getBoundingClientRect();
    }
    return { rects, lastBack };
  }

  patchCenter(v) {
    setText(this.el.round, roundName(v));
    const sub = `${v.wall} left${sticksHTML(v)}`;
    if (this.el.sub._h !== sub) { this.el.sub._h = sub; this.el.sub.innerHTML = sub; }
    const doraKey = v.dora.join(',');
    if (this.el.dora._k !== doraKey) {
      this.el.dora._k = doraKey;
      this.doraSet = doraTypes(v.dora);
      const d = [];
      for (let i = 0; i < 5; i++) d.push(i < v.dora.length ? tileHTML(v.dora[i]) : tileHTML(null));
      this.el.dora.innerHTML = d.join('');
    }
  }

  // layer r shows seat (me + r) % 4: info plate, pond, and (for opponents) hand + melds
  patchSeat(v, r, newPond) {
    const s = (v.seat + r) % 4;
    const p = v.players[s];
    const L = this.layers[r];
    const wind = (s - v.dealer + 4) % 4;
    const isTurn = (v.phase === 'discard' && v.turn === s) || (v.claimTile && v.claimTile.from === s);
    setCls(L.info, `info${isTurn ? ' turn' : ''}${wind === 0 ? ' dealer' : ''}${p.away === 'gone' ? (p.kind === 'bot' ? ' away-gone bot' : ' away-gone') : p.kind === 'bot' ? ' bot' : p.sleep ? ' away-sleep' : ''}`);
    setText(L.wind, WIND_CHARS[wind]);
    setText(L.score, p.score);
    if (L.stick.hidden === !!p.riichi) L.stick.hidden = !p.riichi;
    setText(L.pname, p.name);
    this.patchAnimal(r, p);
    setAway(this.anis[r], awayOf(p));

    const hl = v.claimTile ? v.claimTile.from === s : v.lastDiscard && v.lastDiscard.seat === s;
    const list = [];
    let sideNext = false; // a riichi tile that was called: the next discard turns sideways
    p.discards.forEach((d, i) => {
      const side = d.riichi || sideNext;
      if (d.called) { sideNext = side; return; }
      sideNext = false;
      let mods = side ? 'side' : '';
      if (d.tsumogiri) mods += ' tg';
      if (hl && i === p.discards.length - 1) mods += ' last';
      const el = this.node('t' + d.tile, d.tile);
      if (el.parentNode !== L.pond) { el._from = s; newPond.add(el); }
      list.push([el, mods.trim()]);
    });
    this.place(L.pond, list);
    if (r === 0) return; // your own hand and melds are in the bar

    const backs = [];
    const shown = v.revealed && v.revealed[s];
    if (shown) {
      // hand over: everyone's tiles face up, in place of the backs
      for (const id of shown.hand) backs.push([this.node('t' + id, id), 'rv']);
      if (shown.drawn != null) backs.push([this.node('t' + shown.drawn, shown.drawn), 'rv dr']);
    } else {
      const drew = v.phase === 'discard' && v.turn === s && p.handCount % 3 === 2;
      for (let i = 0; i < p.handCount; i++) backs.push([this.node(`h${s}:${i}`, null), drew && i === p.handCount - 1 ? 'dr' : '']);
    }
    for (const [el] of backs) el._from = s;
    this.place(L.backs, backs);
    this.placeMelds(L.melds, p.melds, s);
    for (const span of L.melds.children) for (const el of span.children) el._from = s;
  }

  patchHand(v, ui) {
    const opts = v.options;
    const allowed = opts ? new Set(ui.riichiMode ? opts.riichi : opts.discard) : null;
    const mods = (id) => {
      let c = allowed ? (allowed.has(id) ? 'can' : 'dim') : '';
      if (ui.selected === id) c += ' sel';
      if (this.drag && this.drag.on && this.drag.id === id) c += ' drag';
      return c;
    };
    let hand = v.hand;
    let drawn = v.drawn;
    if (ui.free) {
      // reconcile your order: drop tiles that left (discards, calls), add new ones at
      // the right end. The drawn tile keeps its own slot until you drag it in (or
      // discard another tile, which brings it in at the end).
      const inHand = new Set(v.hand);
      const order = (this.order || []).filter((id) => inHand.has(id) || id === v.drawn);
      const have = new Set(order);
      for (const id of v.hand) if (!have.has(id)) order.push(id);
      this.order = order;
      hand = order;
      if (drawn != null && have.has(drawn)) drawn = null;
    } else this.order = null;
    if (this.drag && (!ui.free || ![...hand, drawn].includes(this.drag.id))) this.endDrag(false, true);
    this.el.handrow.classList.toggle('free', !!ui.free);
    this.place(this.el.hand, hand.map((id) => [this.node('t' + id, id), mods(id)]));
    this.place(this.el.drawn, drawn != null ? [[this.node('t' + drawn, drawn), mods(drawn)]] : []);
    if (this.drag && this.drag.on) this.dragLayout();
    this.placeMelds(this.el.mymelds, v.players[v.seat].melds, v.seat);
    this.el.bar.classList.toggle('myturn', !!(v.options || v.claim));
    this.el.bar.classList.toggle('riichimode', !!ui.riichiMode);
  }

  /* ---------- unlocked tiles (ui.free): drag a tile to a new place in your hand ----------
     A press only becomes a drag after DRAG_MIN px, so a plain click / tap still
     discards or lifts as before; a drag never clicks. While dragging, the tile
     follows the pointer and the others slide apart (transforms only); the drop
     re-renders with the usual FLIP. */
  setupDrag() {
    const DRAG_MIN = 7;
    const signal = this.off.signal;
    this.dragUntil = 0;
    this.el.handbox.addEventListener('pointerdown', (e) => {
      if (!this.ui || !this.ui.free || this.drag || !e.isPrimary) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const t = e.target.closest('.tile[data-id]');
      if (!t || (t.parentNode !== this.el.hand && t.parentNode !== this.el.drawn)) return;
      const box = this.el.handbox.getBoundingClientRect();
      this.drag = {
        id: +t.dataset.id, el: t, pid: e.pointerId, on: false, slot: null,
        fromDrawn: t.parentNode === this.el.drawn,
        x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
        // grab point, relative to the tile's untransformed spot
        gx: e.clientX - box.left - t.offsetLeft, gy: e.clientY - box.top - t.offsetTop,
      };
    }, { signal });
    window.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.pid) return;
      d.x = e.clientX; d.y = e.clientY;
      if (!d.on) {
        if (Math.hypot(d.x - d.x0, d.y - d.y0) < DRAG_MIN) return;
        this.startDrag();
      }
      if (e.cancelable) e.preventDefault();
      this.dragLayout();
    }, { signal });
    const up = (commit) => (e) => { if (this.drag && e.pointerId === this.drag.pid) this.endDrag(commit && this.drag.on); };
    window.addEventListener('pointerup', up(true), { signal });
    window.addEventListener('pointercancel', up(false), { signal });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.drag && this.drag.on) { e.stopImmediatePropagation(); this.endDrag(false); }
    }, { capture: true, signal });
    // the click that ends a drag must not reach main.js (it would discard)
    window.addEventListener('click', (e) => {
      if (performance.now() - this.dragUntil < 350) { this.dragUntil = 0; e.stopImmediatePropagation(); e.preventDefault(); }
    }, { capture: true, signal });
  }

  startDrag() {
    const d = this.drag;
    d.on = true;
    try { this.el.handbox.setPointerCapture(d.pid); } catch { /* pointer already gone */ }
    // a running FLIP would hold the tiles in place
    for (const a of this.anims) {
      if (a.effect && this.el.handrow.contains(a.effect.target)) { a.cancel(); this.anims.delete(a); }
    }
    if (this.ui.selected != null) {
      this.ui.selected = null;
      for (const el of this.el.handrow.querySelectorAll('.tile.sel')) el.classList.remove('sel');
    }
    d.el.classList.add('drag');
    this.el.handrow.classList.add('dragging');
  }

  // dragged tile under the pointer; the others open a gap at the drop slot
  dragLayout() {
    const d = this.drag;
    const box = this.el.handbox.getBoundingClientRect();
    const kids = [...this.el.hand.children];
    const others = kids.filter((el) => el !== d.el);
    const pitch = kids.length > 1 ? kids[1].offsetLeft - kids[0].offsetLeft : d.el.offsetWidth * 1.06;
    const x0 = kids.length ? kids[0].offsetLeft : d.el.offsetLeft;
    const left = d.x - d.gx - box.left;
    const top = d.y - d.gy - box.top;
    const n = others.length;
    const raw = (left - x0) / pitch;
    // the drawn tile joins the hand once it is moved onto it; past the end it stays apart
    d.slot = d.fromDrawn && raw > n + 0.15 ? null : Math.max(0, Math.min(n, Math.round(raw)));
    const from = d.fromDrawn ? n : kids.indexOf(d.el);
    others.forEach((el, k) => {
      const was = k < from ? k : k + 1;
      const now = d.slot == null ? was : k < d.slot ? k : k + 1;
      const dx = d.fromDrawn && d.slot == null ? 0 : (now - was) * pitch;
      const tf = dx ? `translateX(${dx}px)` : '';
      if (el.style.transform !== tf) el.style.transform = tf;
    });
    d.el.style.transform = `translate(${left - d.el.offsetLeft}px, ${top - d.el.offsetTop}px) scale(1.06)`;
  }

  // commit: move the tile to its drop slot; otherwise everything slides back.
  // quiet: from inside update() (no re-render of our own).
  endDrag(commit, quiet) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (!d.on) return;
    this.dragUntil = performance.now();
    try { this.el.handbox.releasePointerCapture(d.pid); } catch { /* released */ }
    if (commit && d.slot != null && this.order) {
      const order = this.order.filter((id) => id !== d.id);
      order.splice(d.slot, 0, d.id);
      this.order = order;
    }
    const row = this.el.handrow;
    const settle = () => {
      row.classList.add('settle'); // no CSS transitions while the offsets go: FLIP animates instead
      for (const el of row.querySelectorAll('.tiles .tile, .drawn .tile')) el.style.transform = '';
      d.el.classList.remove('drag');
      row.classList.remove('dragging');
      void row.offsetWidth;
      requestAnimationFrame(() => requestAnimationFrame(() => row.classList.remove('settle')));
    };
    if (quiet || !this.v) { settle(); return; }
    this.settleDrag = settle;
    this.update(this.v, this.ui);
  }

  // hint + buttons (only rewritten when they change)
  patchBar(v, ui, rk) {
    // a new hand, a new result or the final standings always (re)opens the card
    const fresh = rk !== this.resKey && (!this.resKey || rk.startsWith('over') !== this.el.modal._over);
    if (!rk || fresh) this.peek = this.celebWait = false;
    if (!this.peek) this.celebWait = false;
    const a = this.celeb ? { html: '', hint: '<span class="cb-hint">Tap to skip</span>' }
      : this.peek && rk ? (this.celebWait && v.result ? afterCelebActions(v) : peekActions(v)) : actionsHTML(v, ui);
    const ak = a.hint + '|' + a.html;
    if (ak !== this.actKey) {
      this.actKey = ak;
      this.el.hint.innerHTML = a.hint;
      this.el.actions.innerHTML = a.html;
    }
  }

  // speech bubble for a new call / riichi / win; returns the event (for sounds)
  patchEvent(v) {
    if (!v.event || v.event.id === this.evId) return null;
    const event = v.event;
    this.evId = event.id;
    const r = (event.seat - v.seat + 4) % 4;
    const kind = /Riichi/.test(event.text) ? 'y' : /Ron|Tsumo/.test(event.text) ? 'g' : /Ryuukyoku/.test(event.text) ? 'b' : 'p';
    if (this.celeb && (kind === 'g' || kind === 'b')) return event; // the celebration says it (still a sound)
    const span = document.createElement('span');
    span.className = `ev p${r} ${kind}`;
    span.textContent = event.text + (kind === 'b' ? '' : '!');
    this.el.announce.replaceChildren(span);
    span.addEventListener('animationend', () => span.remove());
    return event;
  }

  // result card (rewritten only when its key changes)
  patchModal(v, rk) {
    const m = this.el.modal;
    let opened = false;
    if (rk !== this.resKey) {
      const wasOpen = !!this.resKey;
      this.resKey = rk;
      if (rk) {
        this.el.modalcard.innerHTML = resultHTML(v);
        opened = !wasOpen || rk.startsWith('over') !== m._over;
        m._over = rk.startsWith('over');
      }
    }
    m.hidden = !rk || this.peek || !!this.celeb;
    if (opened && !this.celeb) this.showModal();
  }

  flip({ rects, lastBack }, newPond) {
    const D = 210;
    const run = (el, frames, opts) => {
      const an = el.animate(frames, { duration: D, easing: EASE, ...opts });
      this.anims.add(an);
      an.onfinish = () => this.anims.delete(an);
    };
    // animate el from rect `old` (seen at rotation oldAng) to where it is now
    const from = (el, old, oldAng) => {
      const now = el.getBoundingClientRect();
      if (!now.width) return;
      const dx = (old.left + old.width / 2) - (now.left + now.width / 2);
      const dy = (old.top + old.height / 2) - (now.top + now.height / 2);
      const scale = Math.sqrt((old.width * old.height) / (now.width * now.height)) || 1;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(scale - 1) < 0.02) return;
      const angNew = el._ang || 0;
      const a = (-angNew * Math.PI) / 180;
      const lx = dx * Math.cos(a) - dy * Math.sin(a);
      const ly = dx * Math.sin(a) + dy * Math.cos(a);
      let dr = ((oldAng ?? angNew) - angNew) % 360;
      if (dr > 180) dr -= 360;
      if (dr <= -180) dr += 360;
      const far = Math.hypot(dx, dy) > 60;
      run(el, [{ transform: `translate(${lx}px,${ly}px) rotate(${dr}deg) scale(${scale})`, offset: 0 }, { transform: getComputedStyle(el).transform }],
        { duration: far ? D + 30 : D });
    };
    for (const el of this.nodes.values()) {
      if (!el.isConnected) continue;
      const old = rects.get(el);
      const box = el.parentNode;
      if (old) from(el, old.r, old.a);
      else if (newPond.has(el) && lastBack[el._from]) from(el, lastBack[el._from], el._ang); // from that player's hand
      else if (box === this.el.drawn) run(el, [{ transform: 'translateY(-45%)', opacity: 0, offset: 0 }, { transform: 'none', opacity: 1 }]);
      else if (el.classList.contains('back') && box.classList.contains('backs')) run(el, [{ opacity: 0, offset: 0 }, { opacity: 1 }]);
      else if (box.classList.contains('meld') && lastBack[el._from]) from(el, lastBack[el._from], el._ang);
      else run(el, [{ opacity: 0, transform: 'scale(.85)', offset: 0 }, { opacity: 1, transform: 'none' }]);
    }
  }
}
