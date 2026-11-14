// 31 mascots (27 animals, 4 vegetables) as inline SVG, one per seat (the room picks them: view.players[i].animal).
// Shared template: a round outlined head on a 64x64 canvas, plus per-animal ears, markings
// and snout. Groups the CSS animates: .bd (whole body), .ear (each ear), .eo (open eyes,
// blink) and the face variants of eyes() below, shown during emotes. Markup is cached per animal.

const INK = '#3b2f45';
const MIR = (s) => `<g transform="matrix(-1 0 0 1 64 0)">${s}</g>`;
const both = (s) => s + MIR(s);
const ears = (s) => `<g class="ear">${s}</g><g class="ear er">${MIR(s)}</g>`;
const E = (cx, cy, rx, ry, f, x = '') => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${f}"${x}/>`;
const P = (d, f, x = '') => `<path d="${d}" fill="${f}"${x}/>`;
const line = (d, c, w = 1.6, x = '') => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${x}/>`;
const ol = (c, w = 2.2) => ` stroke="${c}" stroke-width="${w}" stroke-linejoin="round"`;

// eyes: dx = half distance, light = pale eyes for dark eye patches
// iris: coloured eyes (e.g. a black cat's gold eyes) — implies light-style eyes
// Besides the open eyes (.eo) every animal gets the face variants the emotes switch to
// (CSS shows one at a time): .eh happy ^^, .ex excited > <, .es sad (droopy eyes looking
// down, worried brows, a tear), .lkl / .lkr looking up to the left / right, .ea angry
// (eyes under brows slanted down toward the middle).
function eyes({ dx = 7, y = 36, r = 2.6, light = false, iris = '' } = {}) {
  const L = 32 - dx, R = 32 + dx;
  if (iris) light = true;
  const c = light ? '#fff' : INK; // strokes drawn on the face
  // one open eye; (px, py): where it looks, as a fraction of r
  const one = (x, px = 0, py = 0) => light
    ? `<circle cx="${x}" cy="${y}" r="${r}" fill="${iris || '#fff'}"/><circle cx="${x + 0.3 + px * r * 0.42}" cy="${y + 0.2 + py * r * 0.42}" r="${r * 0.55}" fill="${INK}"/>`
      + (iris ? `<circle cx="${x + r * 0.35}" cy="${y - r * 0.4}" r="${r * 0.28}" fill="#fff"/>` : '')
    : `${E(x + px * r * 0.45, y + py * r * 0.4, r * 0.92, r * 1.1, INK)}<circle cx="${x + r * 0.32 + px * r * 0.42}" cy="${y - r * 0.42 + py * r * 0.42}" r="${r * 0.36}" fill="#fff"/>`;
  const happy = (x) => line(`M${x - r} ${y + 0.9}q${r} -${r * 1.25} ${r * 2} 0`, c, 1.9);
  // > < : s = 1 on the left eye (points inward), -1 on the right
  const squeeze = (x, s) => line(`M${x - s * r * 0.9} ${y - r * 0.85}L${x + s * r * 0.85} ${y}L${x - s * r * 0.9} ${y + r * 0.85}`, c, 1.8);
  // worried brow: the inner end (towards the middle) higher
  const brow = (x, s) => line(`M${x - s * r * 1.05} ${y - r * 1.55}L${x + s * r * 0.95} ${y - r * 2.15}`, c, 1.4);
  // angry brow: the inner end (towards the middle) lower
  const grr = (x, s) => line(`M${x - s * r * 1.2} ${y - r * 2.25}L${x + s * r * 1.05} ${y - r * 1.2}`, c, 1.9);
  const tear = `<path class="tear" d="M${L - r * 0.2} ${y + r * 1.1}q-2.5 4-.15 5.85q2.55 1.65 3.3-1.8q.15-1.8-3.15-4.05Z" fill="#8fd3ff" stroke="#4fa3d9" stroke-width=".5"/>`;
  return `<g class="eo">${one(L)}${one(R)}</g><g class="eh">${happy(L)}${happy(R)}</g>`
    + `<g class="ex">${squeeze(L, 1)}${squeeze(R, -1)}</g>`
    + `<g class="es">${one(L, 0, 0.8)}${one(R, 0, 0.8)}${brow(L, 1)}${brow(R, -1)}${tear}</g>`
    + `<g class="lkl">${one(L, -1, -0.6)}${one(R, -1, -0.6)}</g><g class="lkr">${one(L, 1, -0.6)}${one(R, 1, -0.6)}</g>`
    + `<g class="ea">${one(L, 0.35, 0.3)}${one(R, -0.35, 0.3)}${grr(L, 1)}${grr(R, -1)}</g>`;
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
    // black cat with golden eyes; a soft lilac outline keeps it visible on dark themes
    const f = '#3a3346', d = '#8a7fa3';
    return ears(pointy(f, d, '#f5a3b8')) + head(f, d)
      + eyes({ iris: '#ffd35c', r: 3 }) + nose(40.8, '#f5a3b8', 2, 1.4) + mouth(43.2, '#d9cfe6')
      + both(line('M8.6 39.6l7 1.2M8.8 45l7-1.6', '#d9cfe6', 1.2, ' opacity=".75"')) + cheeks(42.6, 11.5, 0.45);
  }],
  ['Dog', () => {
    // grey dog
    const f = '#dcdce4', d = '#7c7c8c';
    return head(f, d) + E(40, 32.5, 5.6, 5.2, '#b9b9c7') + E(32, 43.4, 8, 5.8, '#f7f7fb')
      + ears(P('M17 19.5Q6.5 19 6.8 33Q7.2 44 13.4 41.6Q16.4 32 21.6 22.4Z', '#9a9aab', ol(d)))
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
    // mallard drake: green head, white collar, wide flat yellow bill
    const f = '#4f9e6a', d = '#2f6b45';
    return P('M13 50Q32 60 51 50L49 56Q32 63 15 56Z', '#fffaf2', ol('#c9c2d2', 1.2))
      + head(f, d, 20, 18, 34) + E(32, 26, 12, 5, '#6fc08a', ' opacity=".35"')
      + eyes({ dx: 8.4, y: 31.6, r: 2.5 })
      + P('M18.6 42Q20 36.4 32 36.8Q44 36.4 45.4 42Q46 49.4 32 49.6Q18 49.4 18.6 42Z', '#ffc23d', ol('#d98a1f', 1.4))
      + line('M21 43.4Q32 46.2 43 43.4', '#d98a1f', 1.2, ' opacity=".8"')
      + E(28.4, 39.6, 1, 0.7, '#a8641a') + E(35.6, 39.6, 1, 0.7, '#a8641a');
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
  ['Crocodile', () => {
    // soft mint-green croc: small eye bumps close together on top, a long rounded paler
    // snout with little nostrils at the tip, a gentle smile with two tiny teeth and soft
    // scale spots (narrow and tall, unlike the frog's wide face and far-apart eyes)
    const f = '#8fd6a4', d = '#4f9468', s = '#b4e8bf';
    const bump = (x) => both(`<circle cx="25" cy="20.4" r="6" fill="${f}"${x}/>`);
    return bump(ol(d)) + E(32, 29, 17.6, 12.6, f, ol(d)) + bump('')
      + P('M19 33Q17.6 60 32 60Q46.4 60 45 33Q38.6 30 32 30.2Q25.4 30 19 33Z', s, ol(d))
      + both(E(27.2, 31.2, 2.2, 1.4, d, ' opacity=".3"') + E(19.8, 27, 1.6, 1.2, d, ' opacity=".25"'))
      + eyes({ dx: 7, y: 21.4, r: 2.7 })
      + both(E(29.4, 50.6, 1.2, 0.9, d))
      + line('M23.2 51.4Q32 58.2 40.8 51.4', '#3f7553', 1.6)
      + P('M27.4 54.2q.8 2 1.7.5ZM34.9 54.7q.9 1.5 1.7-.5Z', '#fffdf6')
      + cheeks(43, 8.6, 0.6);
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
  ['Shoebill', () => {
    // hashibirokō: grey-blue head, little back tuft, huge pale hooked bill, stern pale eyes
    const f = '#9eb0c4', d = '#5c6f86';
    return P('M41 18Q47 10.6 50.4 13Q47.6 16.4 45 21Z', f, ol(d, 1.6)) + head(f, d, 20, 18, 31)
      + eyes({ dx: 8.6, y: 27.6, r: 2.4, iris: '#f3e7a6' }) + both(line('M20.4 23.6l5.2 1.4', d, 1.6))
      + P('M22.6 34Q32 31.4 41.4 34Q44.6 46 36.6 55.4Q33.6 59.4 32 61Q30.4 59.4 27.4 55.4Q19.4 46 22.6 34Z', '#e7ddc0', ol('#a39672', 1.5))
      + line('M32 35.6V58.6', '#a39672', 1.1, ' opacity=".7"') + P('M29.6 56.6Q32 62 34.4 56.6Q32 58.4 29.6 56.6Z', '#a39672')
      + cheeks(36.6, 13.6, 0.35);
  }],
  ['Bat', () => {
    const f = '#8f7fb4', d = '#584a80', w = '#6f5f99';
    const wing = P('M13.6 36Q3 30.4 1.6 38.6Q5 38 6.4 41.4Q9.4 39.4 11.4 43.6Q13.4 41.2 15.4 43.2Z', w, ol(d, 1.5));
    return both(wing) + ears(P('M14.4 27.4L10.6 6.6Q11.8 5 13.8 6.6L27.8 20Z', f, ol(d)) + P('M16 23L13.6 11.4L23.4 19.6Z', '#f5b7cc'))
      + head(f, d, 19.6, 17.6, 37) + E(32, 44, 9.6, 6.4, '#b7a9da')
      + eyes({ dx: 7, y: 35.4 }) + nose(41.2, INK, 1.8, 1.2)
      + line('M28.4 45.4q3.6 2.4 7.2 0', INK, 1.4) + P('M29.4 45.6l1 2.6 1-2.2ZM32.6 45.8l1 2.2 1-2.6Z', '#fff')
      + cheeks(42.4, 12.2, 0.5);
  }],
  ['Moonfish', () => {
    // manbō (ocean sunfish): tall fins above and below a round silver body
    const f = '#b9c8de', d = '#6d82a3', fin = '#97abc9';
    return P('M26 18Q27.6 2.6 36.4 3.6Q34.6 11 35.6 18Z', fin, ol(d, 1.8)) + P('M26 50Q27.6 63 35.4 61.4Q34 55 35.6 50Z', fin, ol(d, 1.8))
      + E(32, 34, 21.6, 18.6, f, ol(d)) + P('M49 25Q57.4 34 49 43Q52.4 34 49 25Z', fin, ol(d, 1.4))
      + E(28, 41.4, 14, 8.4, '#dfe8f4', ' opacity=".8"')
      + line('M43.6 24.6q2.4 9.4 0 18.8', d, 1.2, ' opacity=".45"')
      + eyes({ dx: 7.4, y: 31 }) + E(32, 39.6, 2.2, 1.8, '#5d6f8f') + cheeks(37.6, 12.6, 0.5);
  }],
  ['Tit', () => {
    // shijūkara: black cap and bib stripe, big white cheeks, a hint of yellow-green below
    const k = '#3a3446', d = '#5f5872';
    return P('M14 48Q32 60 50 48Q49 56 32 57.6Q15 56 14 48Z', '#d9e7a0', ol('#9fb35c', 1.2))
      + head('#fbfaf6', d, 20, 18.4, 35)
      // cap with a gently curved lower edge (no point down the middle)
      + P('M12 35Q12.4 16.6 32 16.6Q51.6 16.6 52 35Q46 30.4 39 30.2Q32 30.6 25 30.2Q18 30.4 12 35Z', k)
      // short bib stripe on the chest, separated from the beak by white
      + P('M29.8 46.4Q32 45.2 34.2 46.4L33.4 54.4Q32 55.8 30.6 54.4Z', k)
      + eyes({ dx: 8, y: 30.6, r: 3, light: true })
      // small grey beak, outlined so it reads as a beak (not a black stripe)
      + P('M29.6 37.6Q32 36.2 34.4 37.6L32 41.8Z', '#6a6380', ol('#fbfaf6', 0.8))
      + cheeks(41.6, 11.8, 0.5);
  }],
  ['Sparrow', () => {
    // chestnut cap, white cheeks with a black spot, little black bib
    const f = '#f4ead8', d = '#8a6440', cap = '#a8693c';
    return head(f, d, 20.6, 18.6, 36) + P('M11.6 34Q12 17.6 32 17.4Q52 17.6 52.4 34Q46 26.4 32 26.8Q18 26.4 11.6 34Z', cap)
      + both(E(17.2, 40.4, 3, 2.4, '#3b2f45', ' opacity=".85"'))
      + eyes({ dx: 7.4, y: 34.6, r: 2.4 })
      + P('M29.2 40Q32 38.6 34.8 40L32 45Z', '#4a3a36')
      + both(line('M14 26.4l-2.6-1.6M17.6 23.4l-1.6-2.4', '#7a4a28', 1.4, ' opacity=".7"')) + cheeks(43.4, 9.6, 0.5);
  }],
  ['Kingfisher', () => {
    // kawasemi: turquoise head with a speckled crown, orange cheeks, white throat, long dark bill
    const b = '#3fa7c9', d = '#256f8a';
    return P('M14.6 48Q32 60.6 49.4 48Q48.4 56.4 32 58Q15.6 56.4 14.6 48Z', '#f29a4e', ol('#c46b27', 1.2))
      + head(b, d, 20.4, 18.6, 34)
      + both(`<circle cx="24" cy="22.6" r="1.1" fill="#bdeefc" opacity=".8"/><circle cx="28.6" cy="20.4" r="1" fill="#bdeefc" opacity=".8"/>`)
      + both(P('M12.6 34Q14 44 22.6 45Q25.4 40.4 23.4 35.6Q18 32.6 12.6 34Z', '#f7a35d'))
      + E(32, 46, 6, 4.4, '#fffaf2')
      + eyes({ dx: 7.4, y: 31.6, r: 2.4 })
      + P('M29 36.4Q32 35 35 36.4L33 50Q32 51.6 31 50Z', '#3b3346')
      + line('M32 37v12.4', '#5d5568', 0.8, ' opacity=".7"') + cheeks(41, 13.6, 0.35);
  }],
  ['Nuthatch', () => {
    // gojūkara: blue-grey cap, black eye stripe, white cheeks, buff flanks, pointed beak
    const g = '#8fa3c4', d = '#5a6b8c';
    return P('M14 48Q32 59.6 50 48Q49 56 32 57.6Q15 56 14 48Z', '#f2c49a', ol('#c99666', 1.2))
      + head('#fdfaf4', d, 20.4, 18.6, 35)
      + P('M11.8 33.4Q12.2 16.6 32 16.6Q51.8 16.6 52.2 33.4Q47 28.4 32 28.4Q17 28.4 11.8 33.4Z', g)
      + both(P('M10.6 34.6Q18 31.6 27 33.6L26.6 36.6Q18 35.6 11.2 38.4Z', '#3a3446'))
      + eyes({ dx: 8, y: 34.8, r: 2.9, light: true })
      + P('M29.6 39.4Q32 38 34.4 39.4L32 46Z', '#4a4458')
      + both(E(19, 47, 3.6, 2.2, '#f2c49a', ' opacity=".8"')) + cheeks(42.6, 12, 0.4);
  }],
  // vegetables: a stem or leaves on top instead of ears
  ['Eggplant', () => {
    // nasu: glossy purple, green cap with pointed sepals, short stem
    const f = '#8e5bb8', d = '#5a347a', g = '#6cbf5a', gd = '#3f7f34';
    return P('M32 14Q46 14 48.4 30Q52.6 48 44.6 56Q38.6 62 32 62Q25.4 62 19.4 56Q11.4 48 15.6 30Q18 14 32 14Z', f, ol(d))
      + E(22.6, 38, 2.6, 9, '#b48ad6', ' opacity=".55" transform="rotate(12 22.6 38)"')
      + P('M30.4 3.6Q32 2.4 33.6 3.6L33.4 13H30.6Z', '#5d8a3a', ol(gd, 1.2))
      + P('M17.6 22Q22 12.4 32 11.4Q42 12.4 46.4 22Q41.8 19.4 39.4 24Q36 17.6 32 22.6Q28 17.6 24.6 24Q22.2 19.4 17.6 22Z', g, ol(gd, 1.4))
      + eyes({ light: true, dx: 7.4, y: 38, r: 2.6 }) + mouth(45.4, '#f4e9fb') + cheeks(44.6, 12, 0.6);
  }],
  ['Tomato', () => {
    // round and red, a green star of sepals and a little stem on top
    const f = '#f2584f', d = '#b3322c', g = '#5fb84e', gd = '#3a7d2f';
    return E(32, 38, 22.4, 19.6, f, ol(d)) + E(23, 31, 4.6, 3, '#ff9b8f', ' opacity=".7" transform="rotate(-24 23 31)"')
      + P('M32 15.4L35.4 20.6L42 19.4L37.8 23.6L40.6 28.4L33.8 25.6L32 30L30.2 25.6L23.4 28.4L26.2 23.6L22 19.4L28.6 20.6Z', g, ol(gd, 1.2))
      + P('M31 9.6Q33.6 8.6 33.4 11L33 17.6H31Z', '#4c8f39', ol(gd, 1))
      + eyes({ dx: 7.6, y: 38.4, r: 2.6 }) + mouth(45.6) + cheeks(45, 13, 0.55);
  }],
  ['Garlic', () => {
    // a cream bulb with clove lines, a pointed neck and little roots
    const f = '#fbf3ea', d = '#b89c86', c = '#e2cdb9';
    return line('M26 57.4l-2 3.2M29.4 58l-.8 3.6M32 58.2v3.8M34.6 58l.8 3.6M38 57.4l2 3.2', '#c9ad92', 1.4)
      + P('M32 6.6Q34.6 12.6 37.6 17.4Q52.6 23.6 52.4 40.4Q52 57.6 32 58Q12 57.6 11.6 40.4Q11.4 23.6 26.4 17.4Q29.4 12.6 32 6.6Z', f, ol(d))
      + line('M32 18.6Q22.6 30 24.2 56.4M32 18.6Q41.4 30 39.8 56.4M32 18.6V57.6', c, 1.3)
      + P('M30.2 10.4Q32 7.4 33.8 10.4L33.2 15.6H30.8Z', '#d9bfe0', ' opacity=".8"')
      + eyes({ dx: 7.6, y: 38.6, r: 2.5 }) + mouth(45.6) + cheeks(45, 13, 0.6);
  }],
  ['Potato', () => {
    // a lumpy brown spud with a few darker spots
    const f = '#d9ab72', d = '#9b6c3d', s = '#b8854b';
    return P('M17 21.6Q29.6 12.4 44.6 17.6Q55 23 53.8 38.4Q52.6 54.4 36.4 56.8Q20 58.6 12.6 46.6Q7.4 32.6 17 21.6Z', f, ol(d))
      + E(41.6, 24.8, 1.8, 1.2, s) + E(18.6, 31.6, 1.4, 2, s) + E(45.8, 48, 1.6, 1.2, s) + E(23.4, 51.4, 1.4, 1, s)
      + E(25, 26.4, 5.4, 2.4, '#ecc795', ' opacity=".7" transform="rotate(-18 25 26.4)"')
      + eyes({ dx: 7.4, y: 37.6, r: 2.5 }) + mouth(44.8) + cheeks(44.2, 13, 0.5);
  }],
];

export const ANIMAL_NAMES = DEFS.map(([n]) => n);
export const ANIMAL_COUNT = DEFS.length;
// which idle moves make sense (all have blink/hop/tilt/wag; these also have ears that move)
const EARLESS = new Set(['Penguin', 'Duck', 'Frog', 'Crocodile', 'Shoebill', 'Moonfish', 'Tit', 'Kingfisher', 'Nuthatch', 'Sparrow', 'Eggplant', 'Tomato', 'Garlic', 'Potato']);
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
