// Reference copy of the original (slow) standard-shanten algorithm, used only by
// test/run.js to check that the optimized js/hand.js gives identical results.
// For one suit (9 counts) enumerate reachable [mentsu, taatsu, pair] tuples.
const suitCache = new Map();

function dominates(b, a) {
  return b[0] >= a[0] && b[1] >= a[1] && b[2] >= a[2];
}
function prune(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    let dom = false;
    for (let j = 0; j < list.length && !dom; j++) {
      if (i !== j && dominates(list[j], list[i]) &&
          (list[j][0] !== list[i][0] || list[j][1] !== list[i][1] || list[j][2] !== list[i][2] || j < i)) dom = true;
    }
    if (!dom) out.push(list[i]);
  }
  return out;
}

function suitOptions(c, off) {
  let key = 0;
  for (let i = 0; i < 9; i++) key = key * 5 + c[off + i];
  let r = suitCache.get(key);
  if (r) return r;
  const a = c.slice(off, off + 9);
  const found = new Map();
  const rec = (i, m, t, p) => {
    while (i < 9 && a[i] === 0) i++;
    if (i === 9) {
      const k = m * 100 + t * 10 + p;
      if (!found.has(k)) found.set(k, [m, t, p]);
      return;
    }
    if (a[i] >= 3) { a[i] -= 3; rec(i, m + 1, t, p); a[i] += 3; }
    if (i <= 6 && a[i + 1] && a[i + 2]) {
      a[i]--; a[i + 1]--; a[i + 2]--; rec(i, m + 1, t, p); a[i]++; a[i + 1]++; a[i + 2]++;
    }
    if (a[i] >= 2) {
      a[i] -= 2;
      if (p === 0) rec(i, m, t, 1);
      rec(i, m, t + 1, p);
      a[i] += 2;
    }
    if (i <= 7 && a[i + 1]) { a[i]--; a[i + 1]--; rec(i, m, t + 1, p); a[i]++; a[i + 1]++; }
    if (i <= 6 && a[i + 2]) { a[i]--; a[i + 2]--; rec(i, m, t + 1, p); a[i]++; a[i + 2]++; }
    a[i]--; rec(i, m, t, p); a[i]++;
  };
  rec(0, 0, 0, 0);
  r = prune([...found.values()]);
  suitCache.set(key, r);
  return r;
}

const H3 = [[1, 0, 0]];
const H2 = [[0, 1, 0], [0, 0, 1]];

export function shantenStdRef(c, open) {
  const groups = [suitOptions(c, 0), suitOptions(c, 9), suitOptions(c, 18)];
  for (let h = 27; h < 34; h++) {
    if (c[h] >= 3) groups.push(H3);
    else if (c[h] === 2) groups.push(H2);
  }
  let cur = [[0, 0, 0]];
  for (const g of groups) {
    const m = new Map();
    for (const a of cur) {
      for (const b of g) {
        const p = a[2] + b[2];
        if (p > 1) continue;
        const x = [a[0] + b[0], a[1] + b[1], p];
        m.set(x[0] * 1000 + x[1] * 10 + x[2], x);
      }
    }
    cur = prune([...m.values()]);
  }
  const need = 4 - open;
  let best = 8;
  for (const [m0, t0, p] of cur) {
    const m = Math.min(m0, need);
    const t = Math.min(t0, need - m);
    const s = 8 - 2 * (m + open) - t - p;
    if (s < best) best = s;
  }
  return best;
}
