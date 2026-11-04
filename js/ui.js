// Table rendering. The game DOM is built once; tile nodes are keyed by tile id
// in one shared Map, so a node can move between hand, pond and meld containers
// and is animated with FLIP (Web Animations API, transform/opacity only).
import { tileType, isRed, doraFromIndicator, WIND_CHARS } from './tiles.js';

const C = { man: '#c8445f', pin: '#3a6fbf', sou: '#26845b', red: '#e0435f', tile: '#fdf6ee' };
const HONOR_CHAR = ['東', '南', '西', '北', '', '發', '中'];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- tile faces (cached markup) ---------------- */

const PIN = [[[50, 50]], [[50, 28], [50, 72]], [[28, 24], [50, 50], [72, 76]], [[30, 28], [70, 28], [30, 72], [70, 72]],
  [[28, 24], [72, 24], [50, 50], [28, 76], [72, 76]], [[32, 20], [68, 20], [32, 50], [68, 50], [32, 80], [68, 80]],
  [[24, 16], [50, 26], [76, 36], [32, 62], [68, 62], [32, 86], [68, 86]],
  [[32, 14], [68, 14], [32, 38], [68, 38], [32, 62], [68, 62], [32, 86], [68, 86]],
  [[22, 18], [50, 18], [78, 18], [22, 50], [50, 50], [78, 50], [22, 82], [50, 82], [78, 82]]];
const SOU = { 2: [[50, 28], [50, 72]], 3: [[50, 28], [30, 72], [70, 72]], 4: [[30, 28], [70, 28], [30, 72], [70, 72]],
  5: [[26, 28], [74, 28], [50, 50], [26, 72], [74, 72]], 6: [[24, 28], [50, 28], [76, 28], [24, 72], [50, 72], [76, 72]],
  7: [[50, 14], [24, 50], [50, 50], [76, 50], [24, 84], [50, 84], [76, 84]],
  8: [[20, 28], [40, 28], [60, 28], [80, 28], [20, 72], [40, 72], [60, 72], [80, 72]],
  9: [[24, 16], [50, 16], [76, 16], [24, 50], [50, 50], [76, 50], [24, 84], [50, 84], [76, 84]] };
const svg = (body) => `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${body}</svg>`;

function pinSVG(n, red) {
  const r = n === 1 ? 21 : n <= 4 ? 14 : n <= 6 ? 12 : 10;
  return svg(PIN[n - 1].map(([x, y], i) => {
    const c = red && n === 5 ? C.red : (n === 1 || (n === 5 && i === 2) || (n === 7 && i < 3)) ? C.man : (i % 2 ? C.sou : C.pin);
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${c}" stroke-width="${r * 0.5}"/><circle cx="${x}" cy="${y}" r="${r * 0.32}" fill="${c}"/>`;
  }).join(''));
}

function souSVG(n, red) {
  if (n === 1) {
    return svg(`<ellipse cx="50" cy="42" rx="22" ry="26" fill="${C.sou}"/><circle cx="42" cy="35" r="5" fill="#fff"/><path d="M36 66 L50 90 L64 66Z" fill="${C.man}"/>`);
  }
  const h = n >= 7 ? 22 : 30;
  return svg(SOU[n].map(([x, y], i) => {
    const c = red && n === 5 ? C.red : (n === 9 && i % 3 === 1) || (n === 7 && i === 0) || (n === 5 && i === 2) ? C.man : C.sou;
    return `<rect x="${x - 8}" y="${y - h / 2}" width="16" height="${h}" rx="8" fill="${c}"/><rect x="${x - 9}" y="${y - 1.6}" width="18" height="3.2" rx="1.6" fill="${C.tile}" opacity=".85"/>`;
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
      for (const pair of c.chi) {
        const lbl = c.chi.length > 1 ? `Chi <span class="mini">${typeTile(tileType(pair[0]))}${typeTile(tileType(pair[1]))}</span>` : 'Chi';
        out.push(b({ type: 'chi', tiles: pair }, lbl, 'call'));
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
    hint = `<span><span class="who">${esc(v.players[v.turn].name)}</span>'s turn</span>`;
  } else if (v.phase === 'claim') {
    hint = 'Waiting for calls…';
  }
  if (!v.options && v.waits && v.waits.length) {
    hint += `<span class="waits">${v.furiten ? '<em>furiten</em>' : 'waits'} ${v.waits.map((t) => typeTile(t)).join('')}</span>`;
  }
  return { html: out.join(''), hint };
}

function deltasTable(v, r) {
  return `<table class="scores">${v.players.map((p, i) => {
    const d = r.deltas[i];
    return `<tr${i === v.seat ? ' class="me"' : ''}><td class="w">${WIND_CHARS[(i - v.dealer + 4) % 4]}</td><td>${esc(p.name)}</td><td class="num">${r.scores[i]}</td>
      <td class="num ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}">${d > 0 ? '+' : ''}${d || ''}</td></tr>`;
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

export function resultHTML(v) {
  const r = v.result;
  if (v.phase === 'over') {
    const rows = v.final.map((f, i) => `<tr${f.seat === v.seat ? ' class="me"' : ''}><td class="rank">${i + 1}</td><td>${esc(f.name)}</td><td class="num">${f.score}</td></tr>`).join('');
    return `<div class="res over"><h2 class="big">Game over</h2><table class="scores final">${rows}</table>
      <div class="btns">${v.isHost ? '<button class="act hot wide" data-act=\'{"type":"ui-lobby"}\'>Back to lobby</button>' : '<p class="muted wait">Waiting for the host…</p>'}
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
      <ul class="yaku${r.yaku.length > 3 ? ' two' : ''}">${r.yaku.map(([n, h]) => `<li><span>${esc(n)}</span><span>${r.yakuman ? '' : h + ' han'}</span></li>`).join('')}</ul>
      <div class="total">${r.yakuman ? '' : `${r.han} han ${r.fu} fu`} ${r.limit ? `<b>${r.limit}</b>` : ''} · <b>${r.points}</b></div>`;
  }
  const readyNames = v.ready.map((s) => esc(v.players[s].name));
  const iAmReady = v.ready.includes(v.seat);
  return `<div class="res ${r.type === 'draw' ? 'draw' : 'win'}">${body}${deltasTable(v, r)}
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

let current = null; // the live Table, for Escape
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !current || !current.root.isConnected) return;
  const menu = document.getElementById('menu');
  if (menu && !menu.hidden) return; // main.js closes the menu first
  if (current.resKey && !current.peek) current.setPeek(true);
});

/* ---------------- keyed table ---------------- */

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const EASE = 'cubic-bezier(.22,1,.36,1)';
const ANGLES = [0, -90, 180, 90]; // rotation of layer r0..r3

function setText(el, s) { s = String(s); if (el._t !== s) { el._t = s; el.textContent = s; } }
function setCls(el, c) { if (el.className !== c) el.className = c; }

export class Table {
  constructor(root) {
    this.root = root;
    this.nodes = new Map(); // key -> tile element ('t'+id for faces, 'h'+seat+':'+i for hidden backs)
    this.anims = new Set();
    this.dealKey = null;
    this.evId = 0;
    this.actKey = null;
    this.resKey = null;
    this.doraSet = new Set(); // tile types that are currently dora (marked with .dora)
    root.innerHTML = `
      <div id="table"><div id="wrap"><div id="board">
        <div class="center"><div class="round"></div><div class="sub"></div><div class="dora"></div></div>
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
      <div id="modal" hidden><div class="card" id="modalcard"></div></div>`;
    const q = (s) => root.querySelector(s);
    this.el = {
      round: q('.center .round'), sub: q('.center .sub'), dora: q('.center .dora'),
      announce: q('#announce'), hint: q('#hint'), actions: q('#actions'), bar: q('#bar'),
      hand: q('#hand .tiles'), drawn: q('#hand .drawn'), mymelds: q('#hand .mymelds'),
      modal: q('#modal'), modalcard: q('#modalcard'),
    };
    this.peek = false; // result card closed to look at the revealed table
    current = this;
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ui]');
      if (b && b.dataset.ui === 'close') this.setPeek(true);
      else if (b && b.dataset.ui === 'open') this.setPeek(false);
      else if (e.target === this.el.modal && this.resKey) this.setPeek(true); // tap on the backdrop
    });
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
  }

  setPeek(on) {
    if (!this.v || this.peek === on) return;
    this.peek = on;
    this.update(this.v, this.ui);
    if (!on) {
      this.el.modal.classList.remove('in');
      void this.el.modal.offsetWidth;
      this.el.modal.classList.add('in');
      const go = this.el.modalcard.querySelector('.go');
      if (go) go.focus({ preventScroll: true });
    }
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
    const me = v.seat;
    this.v = v;
    this.ui = ui;
    const dealKey = `${v.round}:${v.kyoku}:${v.honba}:${v.dora.length ? v.dora[0] : ''}`;
    const animate = this.dealKey === dealKey && !reduceMotion.matches && !document.hidden && typeof Element.prototype.animate === 'function';
    this.dealKey = dealKey;

    // FIRST: where every connected tile is now
    let before = null;
    const lastBack = [];
    if (animate) {
      before = new Map();
      for (const el of this.nodes.values()) if (el.isConnected) before.set(el, { r: el.getBoundingClientRect(), a: el._ang });
      for (let r = 1; r < 4; r++) {
        const b = this.layers[r].backs.lastElementChild;
        if (b) lastBack[(me + r) % 4] = b.getBoundingClientRect();
      }
    }
    for (const a of this.anims) a.cancel();
    this.anims.clear();

    /* ---- patch ---- */
    setText(this.el.round, roundName(v));
    const extra = [v.honba ? `${v.honba} honba` : '', v.sticks ? `${v.sticks} riichi` : ''].filter(Boolean).join(' · ');
    setText(this.el.sub, `${v.wall} left${extra ? `\n${extra}` : ''}`);
    const doraKey = v.dora.join(',');
    if (this.el.dora._k !== doraKey) {
      this.el.dora._k = doraKey;
      this.doraSet = doraTypes(v.dora);
      const d = [];
      for (let i = 0; i < 5; i++) d.push(i < v.dora.length ? tileHTML(v.dora[i]) : tileHTML(null));
      this.el.dora.innerHTML = d.join('');
    }

    const newPond = new Set(); // elements newly added to a pond -> seat
    for (let r = 0; r < 4; r++) {
      const s = (me + r) % 4;
      const p = v.players[s];
      const L = this.layers[r];
      const wind = (s - v.dealer + 4) % 4;
      const isTurn = (v.phase === 'discard' && v.turn === s) || (v.claimTile && v.claimTile.from === s);
      setCls(L.info, `info${isTurn ? ' turn' : ''}${wind === 0 ? ' dealer' : ''}${p.kind === 'bot' ? ' bot' : ''}`);
      setText(L.wind, WIND_CHARS[wind]);
      setText(L.score, p.score);
      if (L.stick.hidden === !!p.riichi) L.stick.hidden = !p.riichi;
      setText(L.pname, p.name);

      const hl = v.claimTile ? v.claimTile.from === s : v.lastDiscard && v.lastDiscard.seat === s;
      const list = [];
      let sideNext = false;
      p.discards.forEach((d, i) => {
        const side = d.riichi || sideNext;
        if (d.called) { sideNext = side; return; }
        sideNext = false;
        let mods = side ? 'side' : '';
        if (d.tsumogiri) mods += ' tg';
        if (hl && i === p.discards.length - 1) mods += ' last';
        const el = this.node('t' + d.tile, d.tile);
        if (!el.isConnected || el.parentNode !== L.pond) { el._from = s; newPond.add(el); }
        list.push([el, mods.trim()]);
      });
      this.place(L.pond, list);

      if (r !== 0) {
        const backs = [];
        const shown = v.revealed && v.revealed[s];
        if (shown) {
          // hand over: everyone's tiles face up, in place of the backs
          for (const id of shown.hand) backs.push([this.node('t' + id, id), 'rv']);
          if (shown.drawn != null) backs.push([this.node('t' + shown.drawn, shown.drawn), 'rv dr']);
          for (const [el] of backs) el._from = s;
        } else {
          const drew = v.phase === 'discard' && v.turn === s && p.handCount % 3 === 2;
          for (let i = 0; i < p.handCount; i++) {
            const el = this.node(`h${s}:${i}`, null);
            el._from = s;
            backs.push([el, drew && i === p.handCount - 1 ? 'dr' : '']);
          }
        }
        this.place(L.backs, backs);
        this.placeMelds(L.melds, p.melds, s);
        for (const span of L.melds.children) for (const el of span.children) el._from = s;
      }
    }

    // own hand
    const opts = v.options;
    const allowed = opts ? new Set(ui.riichiMode ? opts.riichi : opts.discard) : null;
    const mods = (id) => {
      let c = allowed ? (allowed.has(id) ? 'can' : 'dim') : '';
      if (ui.selected === id) c += ' sel';
      return c;
    };
    this.place(this.el.hand, v.hand.map((id) => [this.node('t' + id, id), mods(id)]));
    this.place(this.el.drawn, v.drawn != null ? [[this.node('t' + v.drawn, v.drawn), mods(v.drawn)]] : []);
    this.placeMelds(this.el.mymelds, v.players[me].melds, me);
    this.el.bar.classList.toggle('myturn', !!(v.options || v.claim));
    this.el.bar.classList.toggle('riichimode', !!ui.riichiMode);

    // action bar (only when changed)
    const rk = resultKey(v);
    // a new hand, a new result or the final standings always (re)opens the card
    const fresh = rk !== this.resKey && (!this.resKey || rk.startsWith('over') !== this.el.modal._over);
    if (!rk || fresh) this.peek = false;
    const a = this.peek && rk ? peekActions(v) : actionsHTML(v, ui);
    const ak = a.hint + '|' + a.html;
    if (ak !== this.actKey) {
      this.actKey = ak;
      this.el.hint.innerHTML = a.hint;
      this.el.actions.innerHTML = a.html;
    }

    // speech bubble
    let event = null;
    if (v.event && v.event.id !== this.evId) {
      this.evId = v.event.id;
      event = v.event;
      const r = (v.event.seat - me + 4) % 4;
      const kind = /Riichi/.test(event.text) ? 'y' : /Ron|Tsumo/.test(event.text) ? 'g' : /Ryuukyoku/.test(event.text) ? 'b' : 'p';
      const span = document.createElement('span');
      span.className = `ev p${r} ${kind}`;
      span.textContent = event.text + (kind === 'b' ? '' : '!');
      this.el.announce.replaceChildren(span);
      span.addEventListener('animationend', () => span.remove());
    }

    // result modal (only when its key changes)
    if (rk !== this.resKey) {
      const wasOpen = !!this.resKey;
      this.resKey = rk;
      if (rk) {
        this.el.modalcard.innerHTML = resultHTML(v);
        if (!wasOpen || rk.startsWith('over') !== this.el.modal._over) {
          this.el.modal.hidden = false;
          this.el.modal.classList.remove('in');
          void this.el.modal.offsetWidth;
          this.el.modal.classList.add('in');
        }
        this.el.modal._over = rk.startsWith('over');
      }
    }
    this.el.modal.hidden = !rk || this.peek;

    /* ---- LAST + INVERT + PLAY ---- */
    if (animate) this.flip(before, lastBack, newPond, v);
    return { event };
  }

  flip(before, lastBack, newPond, v) {
    const D = 210;
    const run = (el, frames, opts) => {
      const an = el.animate(frames, { duration: D, easing: EASE, ...opts });
      this.anims.add(an);
      an.onfinish = () => this.anims.delete(an);
    };
    const from = (el, old) => {
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
      let dr = ((old._ang ?? angNew) - angNew) % 360;
      if (dr > 180) dr -= 360;
      if (dr <= -180) dr += 360;
      const far = Math.hypot(dx, dy) > 60;
      run(el, [{ transform: `translate(${lx}px,${ly}px) rotate(${dr}deg) scale(${scale})`, offset: 0 }, { transform: getComputedStyle(el).transform }],
        { duration: far ? D + 30 : D });
    };
    for (const el of this.nodes.values()) {
      if (!el.isConnected) continue;
      const old = before.get(el);
      if (old) {
        old.r._ang = old.a;
        from(el, old.r);
      } else if (newPond.has(el) && lastBack[el._from]) {
        const o = lastBack[el._from];
        o._ang = el._ang;
        from(el, o);
      } else if (el.parentNode === this.el.drawn) {
        run(el, [{ transform: 'translateY(-45%)', opacity: 0, offset: 0 }, { transform: 'none', opacity: 1 }]);
      } else if (el.classList.contains('back') && el.parentNode.classList.contains('backs')) {
        run(el, [{ opacity: 0, offset: 0 }, { opacity: 1 }]);
      } else if (el.parentNode.classList.contains('meld') && lastBack[el._from]) {
        const o = lastBack[el._from];
        o._ang = el._ang;
        from(el, o);
      } else {
        run(el, [{ opacity: 0, transform: 'scale(.85)', offset: 0 }, { opacity: 1, transform: 'none' }]);
      }
    }
  }
}
