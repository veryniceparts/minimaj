// Rendering of the table from a per-seat view.
import { tileType, isRed, WIND_CHARS, WIND_NAMES } from './tiles.js';

const SUIT_CHAR = ['萬', '筒', '索'];
const HONOR_CHAR = ['東', '南', '西', '北', '', '發', '中'];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function tileHTML(id, cls = '', attrs = '') {
  if (id == null || id < 0) return `<span class="tile back ${cls}" ${attrs}></span>`;
  const t = tileType(id);
  let face, kind;
  if (t < 27) {
    kind = 'mps'[Math.floor(t / 9)];
    face = `<b>${(t % 9) + 1}</b><i>${SUIT_CHAR[Math.floor(t / 9)]}</i>`;
  } else {
    kind = t === 31 ? 'haku' : t === 32 ? 'hatsu' : t === 33 ? 'chun' : 'wind';
    face = `<b class="h">${HONOR_CHAR[t - 27]}</b>`;
  }
  return `<span class="tile k-${kind}${isRed(id) ? ' red' : ''} ${cls}" ${attrs}><span class="f">${face}</span></span>`;
}

const typeTile = (t, cls = '') => tileHTML(t * 4 + (t === 4 || t === 13 || t === 22 ? 1 : 0), cls);

function meldHTML(m, owner) {
  const rel = (m.from - owner + 4) % 4; // 3 = left, 2 = across, 1 = right
  if (m.type === 'ankan') {
    return `<span class="meld">${tileHTML(null)}${tileHTML(m.tiles[1])}${tileHTML(m.tiles[2])}${tileHTML(null)}</span>`;
  }
  const own = m.tiles.filter((id) => id !== m.called && id !== m.added);
  const calledHTML = tileHTML(m.called, 'side') + (m.added != null ? tileHTML(m.added, 'side') : '');
  const parts = own.map((id) => tileHTML(id));
  const pos = rel === 3 ? 0 : rel === 2 ? 1 : parts.length;
  parts.splice(pos, 0, calledHTML);
  return `<span class="meld">${parts.join('')}</span>`;
}

function pondHTML(p, highlightLast) {
  return p.discards.map((d, i) => {
    let cls = '';
    if (d.riichi) cls += ' side';
    if (d.called) cls += ' called';
    if (d.tsumogiri) cls += ' tg';
    if (highlightLast && i === p.discards.length - 1) cls += ' last';
    return tileHTML(d.tile, cls);
  }).join('');
}

export function roundName(v) {
  return `${WIND_NAMES[v.round]} ${v.kyoku + 1}`;
}

export function boardHTML(v) {
  const me = v.seat;
  let layers = '';
  for (let r = 0; r < 4; r++) {
    const s = (me + r) % 4;
    const p = v.players[s];
    const wind = (s - v.dealer + 4) % 4;
    const isTurn = (v.phase === 'discard' && v.turn === s) || (v.claimTile && v.claimTile.from === s);
    const hl = v.claimTile ? v.claimTile.from === s : v.lastDiscard && v.lastDiscard.seat === s;
    let edge = '';
    if (r !== 0) {
      const backs = Array.from({ length: p.handCount }, () => tileHTML(null)).join('');
      edge = `<div class="edge"><span class="backs">${backs}</span>${p.melds.map((m) => meldHTML(m, s)).join('')}</div>`;
    }
    layers += `<div class="layer r${r}">
      <div class="info${isTurn ? ' turn' : ''}${wind === 0 ? ' dealer' : ''}"><div class="txt">
        <span class="wind">${WIND_CHARS[wind]}</span>
        <span class="score">${p.score}</span>
        ${p.riichi ? '<span class="stick" title="Riichi"></span>' : ''}
        <span class="pname">${esc(p.name)}${p.kind === 'bot' ? ' <small>cpu</small>' : ''}</span>
      </div></div>
      <div class="pond">${pondHTML(p, hl)}</div>
      ${edge}
    </div>`;
  }
  const dora = [];
  for (let i = 0; i < 5; i++) dora.push(i < v.dora.length ? tileHTML(v.dora[i]) : tileHTML(null));
  const center = `<div class="center">
    <div class="round">${roundName(v)}</div>
    <div class="sub">${v.honba ? `${v.honba} honba · ` : ''}${v.sticks ? `${v.sticks} riichi · ` : ''}${v.wall} left</div>
    <div class="dora">${dora.join('')}</div>
  </div>`;
  return center + layers;
}

export function handHTML(v, ui) {
  const opts = v.options;
  let allowed = null;
  if (opts) allowed = new Set(ui.riichiMode ? opts.riichi : opts.discard);
  const tileCls = (id) => {
    let c = '';
    if (allowed) c += allowed.has(id) ? ' can' : ' dim';
    if (ui.selected === id) c += ' sel';
    return c;
  };
  const hand = v.hand.map((id) => tileHTML(id, tileCls(id), `data-id="${id}"`)).join('');
  const drawn = v.drawn != null ? `<span class="gap"></span>${tileHTML(v.drawn, tileCls(v.drawn), `data-id="${v.drawn}"`)}` : '';
  const melds = v.players[v.seat].melds.map((m) => meldHTML(m, v.seat)).join('');
  return `<div class="handrow"><span class="tiles">${hand}${drawn}</span><span class="mymelds">${melds}</span></div>`;
}

// Returns { html, hint } for the action bar.
export function actionsHTML(v, ui) {
  const b = (act, label, cls = '') => `<button class="act ${cls}" data-act='${esc(JSON.stringify(act))}'>${label}</button>`;
  const out = [];
  let hint = '';
  if (v.claim) {
    const c = v.claim;
    if (c.ron) out.push(b({ type: 'ron' }, 'Ron', 'hot'));
    if (c.pon) out.push(b({ type: 'pon' }, 'Pon'));
    if (c.kan) out.push(b({ type: 'kan' }, 'Kan'));
    if (c.chi) {
      for (const pair of c.chi) {
        const lbl = c.chi.length > 1 ? `Chi <span class="mini">${typeTile(pair[0])}${typeTile(pair[1])}</span>` : 'Chi';
        out.push(b({ type: 'chi', tiles: pair }, lbl));
      }
    }
    out.push(b({ type: 'pass' }, 'Pass', 'ghost'));
    hint = `${esc(v.players[c.from].name)} discarded`;
  } else if (v.options) {
    const o = v.options;
    if (o.tsumo) out.push(b({ type: 'tsumo' }, 'Tsumo', 'hot'));
    if (o.riichi.length) out.push(b({ type: 'ui-riichi' }, ui.riichiMode ? 'Cancel riichi' : 'Riichi', ui.riichiMode ? 'ghost' : ''));
    for (const t of o.ankan) out.push(b({ type: 'ankan', t }, `Kan <span class="mini">${typeTile(t)}</span>`));
    for (const t of o.kakan) out.push(b({ type: 'kakan', t }, `Kan <span class="mini">${typeTile(t)}</span>`));
    hint = ui.riichiMode ? 'Riichi: choose a tile to discard' : (v.riichiLocked ? 'Riichi — auto discard' : 'Your turn — discard a tile');
  } else if (v.phase === 'discard') {
    hint = `${esc(v.players[v.turn].name)}'s turn`;
  } else if (v.phase === 'claim') {
    hint = 'Waiting for calls…';
  }
  if (!v.options && v.waits && v.waits.length) {
    hint += `<span class="waits">${v.furiten ? '<em>furiten</em>' : 'waiting'} ${v.waits.map((t) => typeTile(t)).join('')}</span>`;
  }
  return { html: out.join(''), hint };
}

function deltasTable(v, r) {
  return `<table class="scores">${v.players.map((p, i) => {
    const d = r.deltas[i];
    return `<tr><td>${WIND_CHARS[(i - v.dealer + 4) % 4]}</td><td>${esc(p.name)}</td><td class="num">${r.scores[i]}</td>
      <td class="num ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}">${d > 0 ? '+' : ''}${d || ''}</td></tr>`;
  }).join('')}</table>`;
}

export function resultHTML(v, ui) {
  const r = v.result;
  if (v.phase === 'over') {
    const rows = v.final.map((f, i) => `<tr><td>${i + 1}</td><td>${esc(f.name)}</td><td class="num">${f.score}</td></tr>`).join('');
    return `<h2>Game over</h2><table class="scores final">${rows}</table>
      ${ui.isHost ? '<button class="act hot" data-act=\'{"type":"ui-lobby"}\'>Back to lobby</button>' : '<p class="muted">Waiting for host…</p>'}`;
  }
  let body;
  if (r.type === 'draw') {
    body = `<h2>Ryuukyoku <small>exhaustive draw</small></h2>
      ${r.tenpai.length ? r.hands.map((h) => `<div class="rhand"><div class="who">${esc(v.players[h.seat].name)} — tenpai</div>
        ${h.hand.map((id) => tileHTML(id)).join('')}${h.melds.map((m) => meldHTML(m, h.seat)).join('')}</div>`).join('') : '<p class="muted">Nobody tenpai</p>'}`;
  } else {
    const w = v.players[r.winner];
    const how = r.type === 'tsumo' ? 'Tsumo' : `Ron from ${esc(v.players[r.from].name)}`;
    body = `<h2>${esc(w.name)} <small>${how}</small></h2>
      <div class="rhand">${r.hand.map((id) => tileHTML(id)).join('')}<span class="gap"></span>${tileHTML(r.winTile, 'win')}
        ${r.melds.map((m) => meldHTML(m, r.winner)).join('')}</div>
      <div class="indic">Dora ${r.dora.map((id) => tileHTML(id)).join('')}${r.ura.length ? ` Ura ${r.ura.map((id) => tileHTML(id)).join('')}` : ''}</div>
      <ul class="yaku">${r.yaku.map(([n, h]) => `<li><span>${esc(n)}</span><span>${r.yakuman ? '' : h + ' han'}</span></li>`).join('')}</ul>
      <div class="total">${r.yakuman ? '' : `${r.han} han ${r.fu} fu`} ${r.limit ? `<b>${r.limit}</b>` : ''} · ${r.points}</div>`;
  }
  const readyNames = v.ready.map((s) => esc(v.players[s].name));
  const iAmReady = v.ready.includes(v.seat);
  return `${body}${deltasTable(v, r)}
    ${iAmReady ? `<p class="muted">Waiting for others… ${readyNames.length ? '(ready: ' + readyNames.join(', ') + ')' : ''}</p>`
    : `<button class="act hot" data-act='{"type":"ready"}'>${r.gameOver ? 'See results' : 'Next hand'}</button>`}`;
}
