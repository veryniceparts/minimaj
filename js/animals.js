// 20 animal mascots as inline SVG, one per seat (the room picks them: view.players[i].animal).
// Shared template: a round outlined head on a 64x64 canvas, plus per-animal ears, markings
// and snout. Groups the CSS animates: .bd (whole body), .ear (each ear), .eo (open eyes,
// blink), .eh (happy ^^ eyes, shown during the tap reaction). Markup is cached per animal.

const INK = '#3b2f45';
const MIR = (s) => `<g transform="matrix(-1 0 0 1 64 0)">${s}</g>`;
const both = (s) => s + MIR(s);
const ears = (s) => `<g class="ear">${s}</g><g class="ear er">${MIR(s)}</g>`;
const E = (cx, cy, rx, ry, f, x = '') => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${f}"${x}/>`;
const P = (d, f, x = '') => `<path d="${d}" fill="${f}"${x}/>`;
const line = (d, c, w = 1.6, x = '') => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${x}/>`;
const ol = (c, w = 2.2) => ` stroke="${c}" stroke-width="${w}" stroke-linejoin="round"`;

// eyes: dx = half distance, light = pale eyes for dark eye patches
function eyes({ dx = 7, y = 36, r = 2.6, light = false } = {}) {
  const L = 32 - dx, R = 32 + dx;
  const one = (x) => light
    ? `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff"/><circle cx="${x + 0.3}" cy="${y + 0.2}" r="${r * 0.55}" fill="${INK}"/>`
    : `${E(x, y, r * 0.92, r * 1.1, INK)}<circle cx="${x + r * 0.32}" cy="${y - r * 0.42}" r="${r * 0.36}" fill="#fff"/>`;
  const happy = (x) => line(`M${x - r} ${y + 0.9}q${r} -${r * 1.25} ${r * 2} 0`, light ? '#fff' : INK, 1.9);
  return `<g class="eo">${one(L)}${one(R)}</g><g class="eh">${happy(L)}${happy(R)}</g>`;
}
const cheeks = (y = 42.5, dx = 11.5, op = 0.55) => both(E(32 - dx, y, 3.4, 2.1, '#ff8fab', ` opacity="${op}"`));
const nose = (y = 41, c = INK, rx = 1.9, ry = 1.35) => E(32, y, rx, ry, c);
const mouth = (y = 43.2, c = INK) => line(`M29 ${y}q1.5 1.7 3 0q1.5 1.7 3 0`, c, 1.4);
const head = (f, d, rx = 21, ry = 19, cy = 36) => E(32, cy, rx, ry, f, ol(d));
// ears, left side (mirrored for the right)
const pointy = (f, d, inner) => P('M13.5 28L12.6 10.4Q13 7.8 15.6 9L29 19Z', f, ol(d)) + P('M16 23.6L15.8 13.4L25 19.6Z', inner);
const round = (f, d, inner, cx = 15.5, cy = 20, r = 6.5) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${f}"${ol(d)}/><circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="${inner}"/>`;

const DEFS = [
  ['Cat', () => {
    const f = '#ffd3a5', d = '#c27a4a';
    return ears(pointy(f, d, '#ffb3c1')) + head(f, d)
      + line('M32 18.2v4.6M26.6 19.4l1 3.6M37.4 19.4l-1 3.6', d, 2, ' opacity=".65"')
      + eyes() + nose(40.6, '#f07f98', 2, 1.4) + mouth()
      + both(line('M8.6 39.6l7 1.2M8.8 45l7-1.6', d, 1.2, ' opacity=".7"')) + cheeks();
  }],
  ['Dog', () => {
    const f = '#f6dfbf', d = '#a5734d';
    return head(f, d) + E(40, 32.5, 5.6, 5.2, '#e2b386') + E(32, 43.4, 8, 5.8, '#fffaf1')
      + ears(P('M17 19.5Q6.5 19 6.8 33Q7.2 44 13.4 41.6Q16.4 32 21.6 22.4Z', '#c08a5c', ol(d)))
      + eyes() + nose(40.4, INK, 2.9, 2.1) + mouth(43.6) + cheeks(43.5, 12.5);
  }],
  ['Fox', () => {
    const f = '#ffac74', d = '#c8673a';
    return ears(P('M12 30L10.6 6.8Q11.2 4.6 13.8 5.8L28.4 18Z', f, ol(d)) + P('M14.6 24L13.8 10.4L23.4 18.2Z', '#fff2e4'))
      + head(f, d) + P('M11.6 39.2Q21 36.6 32 46.2Q43 36.6 52.4 39.2Q50.4 54.6 32 55Q13.6 54.6 11.6 39.2Z', '#fff6ec')
      + eyes({ y: 34.5 }) + nose(45.6, INK, 2.2, 1.6) + mouth(47.8) + cheeks(42.8, 13);
  }],
  ['Panda', () => {
    const k = '#433d52';
    return ears(`<circle cx="15.4" cy="20" r="6.6" fill="${k}"/>`) + head('#fffdfb', '#5d566b')
      + both(E(24.6, 36.8, 5.2, 6.4, k, ' transform="rotate(28 24.6 36.8)"'))
      + eyes({ light: true, r: 2.3, dx: 7.4 }) + nose(42.4, k, 2.2, 1.6) + mouth(44.4, k) + cheeks(45, 12.4);
  }],
  ['Rabbit', () => {
    const f = '#fff3f7', d = '#c896ab';
    return ears(P('M19.4 22.4Q13.6 4.4 18.8 2.6Q24.4 1.6 26.4 19.4Z', f, ol(d)) + P('M20.6 18.6Q17.2 7.4 19.6 5.8Q22.6 5.6 23.6 18.2Z', '#ffbfd2'))
      + head(f, d) + eyes() + nose(40.8, '#f07f98', 1.9, 1.3) + line('M32 42v1.6M29.4 44q2.6 2 5.2 0', INK, 1.4) + cheeks();
  }],
  ['Bear', () => {
    const f = '#d9a57c', d = '#94603c';
    return ears(round(f, d, '#f3cba8')) + head(f, d) + E(32, 43, 7.8, 5.6, '#f6dcc4')
      + eyes() + nose(40.6, INK, 2.7, 1.9) + mouth(43.4) + cheeks(42.4, 12.6);
  }],
  ['Frog', () => {
    const f = '#addf8e', d = '#5b9a4b';
    const bump = (x) => both(`<circle cx="21" cy="25" r="8" fill="${f}"${x}/>`);
    return bump(ol(d)) + E(32, 40, 22, 15.5, f, ol(d)) + bump('')
      + eyes({ dx: 11, y: 25, r: 3.1 }) + both(E(30, 37.6, 0.9, 0.7, d))
      + line('M23 43.4Q32 50 41 43.4', '#3f6b34', 1.8) + cheeks(44, 14);
  }],
  ['Penguin', () => {
    const f = '#7083b4', d = '#3f4b6e', w = '#fffaf2';
    return head(f, d) + both(E(25.4, 37.6, 9, 10.2, w)) + E(32, 45, 12.6, 8.8, w)
      + line('M30.4 17.6q1.6-4.4 4.6-3.4', d, 2) + eyes({ y: 36.6, dx: 6.6 })
      + P('M28.4 42.2Q32 39.4 35.6 42.2Q32 47 28.4 42.2Z', '#ffb44f', ol('#d9822b', 1)) + cheeks(44.2, 12.6, 0.6);
  }],
  ['Owl', () => {
    const f = '#c7b4ea', d = '#7d66b0';
    return ears(P('M13.4 25L11.6 9.6Q12.4 8.2 14.6 9.4L24.6 19Z', f, ol(d))) + head(f, d)
      + both(`<circle cx="24.6" cy="35" r="7.4" fill="#fff6e8"${ol(d, 1.3)}/>`)
      + eyes({ dx: 7.4, y: 35.4, r: 3 }) + P('M29.4 41.2H34.6L32 46.2Z', '#ffb44f', ol('#d9822b', 1))
      + line('M26.2 50.4l2 2 2-2M33.8 50.4l2 2 2-2', d, 1.4, ' opacity=".6"');
  }],
  ['Koala', () => {
    const f = '#bec5d3', d = '#737c92';
    return ears(round(f, d, '#f4f4f9', 13.4, 25, 9.4)) + head(f, d, 20, 18.4)
      + eyes({ dx: 8.6, y: 35, r: 2.4 }) + E(32, 40.4, 4.2, 5.4, '#4a4458') + E(31, 38.2, 1.3, 1.6, '#fff', ' opacity=".35"')
      + line('M29.6 47.4q2.4 1.6 4.8 0', INK, 1.4) + cheeks(43.2, 12.8);
  }],
  ['Tiger', () => {
    const f = '#ffbd6b', d = '#c4722c', s = '#9a5420';
    return ears(round(f, d, '#fff1dd', 16, 19.6, 6)) + head(f, d)
      + line('M32 17.6v5.4M26.2 18.8l1.4 4.4M37.8 18.8l-1.4 4.4', s, 2.3, ' opacity=".8"')
      + both(line('M11.6 33.6l5.6 1.6M11.8 40.4l5.4-.6', s, 2.2, ' opacity=".8"'))
      + both(E(28, 44, 5.2, 4.2, '#fff6ea')) + eyes({ y: 34.8 }) + nose(41.2, '#e0706a', 2.4, 1.6) + mouth(43.6) + cheeks(41.6, 13.6, 0.4);
  }],
  ['Pig', () => {
    const f = '#ffc8d6', d = '#d47e98';
    return ears(P('M14 24.6L14.4 10.6Q15.4 9.2 17.4 10.4L27.4 18.6Z', f, ol(d)) + P('M16.4 21L16.6 13.6L23.2 18.4Z', '#ffadc2'))
      + head(f, d) + eyes({ y: 34 }) + E(32, 42, 7, 5, '#ffaec3', ol(d, 1.3))
      + E(29.4, 42, 1.2, 1.8, '#c4637f') + E(34.6, 42, 1.2, 1.8, '#c4637f') + cheeks(41.6, 13.8);
  }],
  ['Hamster', () => {
    const f = '#f8cd92', d = '#c08744';
    return ears(round(f, d, '#ffb9c6', 17, 20.6, 5)) + head(f, d, 22, 18.6, 37)
      + P('M10.6 40Q12 54.6 32 55.6Q52 54.6 53.4 40Q47.4 32.6 40 38Q32 43.4 24 38Q16.6 32.6 10.6 40Z', '#fffaf2')
      + eyes({ dx: 8, y: 34.4, r: 2.5 }) + nose(40.2, '#f07f98', 1.7, 1.2) + mouth(42.2) + cheeks(44, 13.4, 0.6);
  }],
  ['Duck', () => {
    const f = '#ffe27c', d = '#cf9f24';
    return P('M30.6 18Q28.6 10.6 33 9.2Q32.4 13 35.6 12.4Q35.6 16.6 33 18.4Z', f, ol(d, 1.8)) + head(f, d)
      + eyes({ y: 35 }) + E(32, 43.4, 7.6, 3.8, '#ffa44c', ol('#d9772b', 1.2)) + line('M26.4 43.4h11.2', '#d9772b', 1, ' opacity=".7"') + cheeks(42, 13.4);
  }],
  ['Sheep', () => {
    const w = '#fbf8ff', wd = '#ab9fc0', f = '#f6d2b8', d = '#b9876a';
    const puffs = [[14.6, 30, 7], [18.4, 20.6, 7], [26.8, 15, 7], [37.2, 15, 7], [45.6, 20.6, 7], [49.4, 30, 7], [13.6, 39.4, 5.6], [50.4, 39.4, 5.6]];
    return puffs.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${w}"${ol(wd)}/>`).join('')
      + `<circle cx="32" cy="27" r="17" fill="${w}"/>`
      + ears(E(14.4, 40, 6, 3, f, ol(d, 1.6) + ' transform="rotate(-18 14.4 40)"'))
      + E(32, 40, 14.6, 14.6, f, ol(d))
      + [[24.6, 26.4], [32, 24.2], [39.4, 26.4]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5.8" fill="${w}"${ol(wd, 1.6)}/>`).join('')
      + eyes({ dx: 6, y: 39.4, r: 2.4 }) + nose(44.2, INK, 1.6, 1.1) + mouth(46) + cheeks(45, 9.6, 0.6);
  }],
  ['Monkey', () => {
    const f = '#bb8d6b', d = '#7d5338', m = '#f6d6ba';
    return ears(round(f, d, m, 11.4, 37, 6.6)) + head(f, d)
      + both(E(25.6, 34.6, 7.6, 7.2, m)) + E(32, 44.2, 12.4, 8.4, m)
      + line('M28.4 18.6q3.6-5.6 7 0', d, 1.8) + eyes({ dx: 6.4, y: 35 })
      + E(30.6, 41, 0.9, 0.8, INK) + E(33.4, 41, 0.9, 0.8, INK) + line('M27.6 44.6q4.4 3.4 8.8 0', INK, 1.5) + cheeks(44, 13);
  }],
  ['Lion', () => {
    const f = '#ffd88f', d = '#c38937', m = '#eea35a', md = '#b9692b';
    let mane = '';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      mane += `<circle cx="${(32 + Math.cos(a) * 21).toFixed(1)}" cy="${(36 + Math.sin(a) * 20).toFixed(1)}" r="7" fill="${m}"${ol(md, 1.8)}/>`;
    }
    return mane + `<circle cx="32" cy="36" r="21" fill="${m}"/>` + ears(round(f, d, '#fff0d2', 18.4, 21.4, 4.8))
      + head(f, d, 17.4, 16.4) + both(E(28.4, 42.6, 4.6, 3.8, '#fff6e4'))
      + eyes({ dx: 6.2, y: 34.4, r: 2.4 }) + P('M29.6 38.6H34.4L32 41.4Z', INK, ol(INK, 1)) + cheeks(40.6, 11.6, 0.5);
  }],
  ['Raccoon', () => {
    const f = '#c4bfcf', d = '#726a86', k = '#5a5268';
    return ears(pointy(f, d, '#5a5268')) + head(f, d)
      + P('M10.6 36.4Q16 28.4 25 31Q32 33.8 39 31Q48 28.4 53.4 36.4Q48 43.6 39 40.4Q32 38 25 40.4Q16 43.6 10.6 36.4Z', k)
      + both(E(23.6, 27.2, 3.6, 1.6, '#fff')) + E(32, 45.2, 7.4, 5.2, '#fffdfb')
      + line('M32 17.4v7', d, 2.2, ' opacity=".7"') + eyes({ light: true, dx: 7.6, y: 35.6, r: 2.4 }) + nose(42.6, INK, 2.2, 1.6) + mouth(44.8) + cheeks(45.4, 13.6, 0.5);
  }],
  ['Axolotl', () => {
    const f = '#ffc3dd', d = '#de7fab', g = '#f58fc0';
    const gills = (w, c) => line('M15 31Q7.4 26.4 5.4 19.6M12.6 37Q5.4 36 2.6 31.6M13.4 43Q6.4 45.4 4.4 50.6', c, w);
    return ears(gills(6.2, d) + gills(3.8, g)) + head(f, d, 21.4, 17, 38)
      + eyes({ dx: 10, y: 36.6, r: 2.5 }) + line('M24.6 43.4Q32 48.6 39.4 43.4', '#9b4a70', 1.7) + cheeks(42.8, 14.4, 0.6);
  }],
  ['Otter', () => {
    const f = '#ad8264', d = '#6f4a31', m = '#f2dcc5';
    return ears(round(f, d, '#d9b394', 14.6, 23.6, 4.2)) + head(f, d, 21.4, 18) + E(32, 29, 13, 7, '#c29a7a')
      + both(E(26.6, 43, 6.8, 5.2, m)) + eyes({ dx: 7.4, y: 34.4 }) + nose(39.8, INK, 3, 2.1)
      + both(`<circle cx="25.4" cy="42.8" r=".8" fill="${INK}" opacity=".5"/><circle cx="23.2" cy="45" r=".8" fill="${INK}" opacity=".5"/>`)
      + mouth(42.4) + cheeks(44.6, 14, 0.45);
  }],
];

export const ANIMAL_NAMES = DEFS.map(([n]) => n);
export const ANIMAL_COUNT = DEFS.length;
// which idle moves make sense (all have blink/hop/tilt/wag; these also have ears that move)
const EARLESS = new Set(['Penguin', 'Duck', 'Frog']);
export const animalMoves = (i) => (EARLESS.has(ANIMAL_NAMES[i]) ? ['blink', 'hop', 'tilt', 'wag'] : ['blink', 'ear', 'hop', 'tilt', 'wag']);

const cache = new Map();
// svg markup for animal i (any integer; wraps around)
export function animalSVG(i) {
  const k = ((i | 0) % DEFS.length + DEFS.length) % DEFS.length;
  let s = cache.get(k);
  if (!s) {
    s = `<svg class="an" viewBox="0 0 64 64" aria-hidden="true"><g class="bd">${DEFS[k][1]()}</g></svg>`;
    cache.set(k, s);
  }
  return s;
}
