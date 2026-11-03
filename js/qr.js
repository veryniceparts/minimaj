// QR code encoder (byte mode, UTF-8 via ECI, error correction level M).
// A readable port of lean-qr's "nano" build, with TextEncoder replaced so it
// also runs in plain JS engines (the Go server's goja).
//
// lean-qr — MIT License — Copyright (c) 2021-2025 David Evans
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

const EC_FRACTION = [0.2, 3 / 8, 5 / 9, 2 / 3];
// per (version, level): ECC bytes per block (versions 1-2 and 3-L) or block count
const BLOCK_TABLE = "*-04-39?2$%%$%%'$%''%'''%')(%'))%(++'(++'(+.'+-.',/3',33)-/5)-43).36)058*18<+37<+4:<,4:E,5<A-7>C/8@F/:EH/<EK0=FM1?IP2@KS3BNV4DPY5FS\\6HV_6IXb7K[e8N^i9Pam;Rdp<Tgt";

function blockInfo(version, totalBytes, level) {
  const n = 4 * version + level - 4;
  const v = BLOCK_TABLE.charCodeAt(n) - 35;
  const blocks = n > 8 ? v : 1;
  const per = (totalBytes / blocks) | 0;
  const longBlocks = totalBytes % blocks;
  const shortBlocks = blocks - longBlocks;
  const ecc = n > 8 ? ((per * EC_FRACTION[level] + (version > 5)) & -2) : v;
  const data = per - ecc;
  return { dataBytes: shortBlocks * data + longBlocks * data + longBlocks, groups: [[shortBlocks, data], [longBlocks, data + 1]], ecc };
}

const bytes = (n) => new Uint8Array(n);

function newMatrix(size, from) {
  const m = from ? new Uint8Array(from) : bytes(size * size);
  return { size, d: m };
}

const MASKS = [
  (x, y) => 1 & (x ^ y),
  (x, y) => 1 & y,
  (x) => x % 3,
  (x, y) => (x + y) % 3,
  (x, y) => 1 & ((x / 3) ^ (y >> 1)),
  (x, y) => (x & y & 1) + ((x * y) % 3),
  (x, y) => ((x & y) + ((x * y) % 3)) & 1,
  (x, y) => ((x ^ y) + ((x * y) % 3)) & 1,
];

// GF(256): GF[i] = exp(i) for i < 255, GF[v + 255] = log(v)
const GF = bytes(511);
for (let i = 0, v = 1; i < 255; v = (2 * v) ^ (285 * (v > 127))) { GF[GF[v + 255] = i++] = v; }
const gfExp = (i) => GF[i % 255];
const gfLog = (v) => GF[v + 255];

function polyMulLog(a, b) {
  const r = bytes(a.length + b.length - 1);
  for (let i = 0; i < a.length; ++i) for (let j = 0; j < b.length; ++j) r[i + j] ^= gfExp(a[i] + b[j]);
  return r.map(gfLog);
}
function polyRem(data, genLog) {
  const r = bytes(data.length + genLog.length - 1);
  r.set(data, 0);
  for (let i = 0; i < data.length; ++i) {
    if (r[i]) {
      const l = gfLog(r[i]);
      for (let j = 0; j < genLog.length; ++j) r[i + j] ^= gfExp(genLog[j] + l);
    }
  }
  return r.slice(data.length);
}
const GENERATORS = [[0], [0, 0]];
for (let i = 1; i < 30; ++i) GENERATORS.push(polyMulLog(GENERATORS[i], [0, i]));

function interleave(data, info) {
  const parts = [[], []];
  let pos = 0, total = 0;
  for (const [count, size] of info.groups) {
    for (let k = 0; k < count; ++k, pos += size) {
      const block = data.slice(pos, pos + size);
      parts[0].push(block);
      parts[1].push(polyRem(block, GENERATORS[info.ecc]));
      total += size + info.ecc;
    }
  }
  const out = bytes(total);
  total = 0;
  for (const list of parts) {
    for (let col = 0, before = -1; before < total; ++col) {
      before = total;
      for (const b of list) if (col < b.length) out[total++] = b[col];
    }
  }
  return out;
}

function bch(value, poly, bits) {
  let r = (value <<= bits);
  for (let t = 134217728; (t >>= 1);) if (r & t) r ^= poly * (t >> bits);
  return r | value;
}

// function patterns: value 2 = reserved light, 3 = reserved dark
function drawFixed(m, version) {
  const size = m.size, d = m.d;
  const rect = (start, w, h, val) => { for (; h-- > 0; start += size) d.fill(val, start, start + w); };
  const rings = (x, y, n) => { for (let k = 0; k++ < 3; n -= 2) rect(y * size + x - (n >> 1) * (size + 1), n, n, 2 | k); };
  const step = 2 * ((((size - 13) / (1 + ((version / 7) | 0))) / 2 + 0.75) | 0);
  if (version > 1) {
    for (let x = size - 7; x > 8; x -= step) {
      for (let y = x; y > 8; y -= step) rings(x, y, 5);
      if (x < size - 7) rings(x, 6, 5);
    }
  }
  if (version > 6) {
    for (let info = bch(version, 7973, 12), row = 1; row < 7; ++row) {
      for (let k = 12; k-- > 9; info >>= 1) d[row * size - k] = 2 | (1 & info);
    }
  }
  rect(7, 2, 9, 2);
  rect(size - 8, 8, 9, 2);
  for (let i = 0; i < size; ++i) d[6 * size + i] = 3 ^ (1 & i);
  rings(3, 3, 7);
  rings(size - 4, 3, 7);
  for (let i = 0; i < size; ++i) for (let j = i; j < size; ++j) d[j * size + i] = d[i * size + j];
  d[(size - 8) * size + 8] = 3;
}

function dataPositions(m) {
  const size = m.size, d = m.d, out = [];
  for (let x = size - 2, y = size, dir = -1; x >= 0; x -= 2) {
    if (x === 5) x = 4;
    for (;;) {
      y += dir;
      if (y === -1 || y === size) break;
      const i = y * size + x;
      if (!d[i + 1]) out.push(i + 1);
      if (!d[i]) out.push(i);
    }
    dir *= -1;
  }
  return out;
}

function applyMask(m, fn, mask, level) {
  const size = m.size, d = m.d;
  for (let y = 0; y < size; ++y) {
    for (let x = 0; x < size; ++x) {
      const i = y * size + x;
      d[i] ^= !(fn(x, y) || (2 & d[i]));
    }
  }
  let f = 21522 ^ bch(((1 ^ level) << 3) | mask, 1335, 10);
  for (let k = 0; k++ < 8; f >>= 1) {
    d[(k - (k < 7)) * size + 8] = 1 & f;
    d[9 * size - k] = 1 & f;
  }
  for (let k = 8; (--k, f); f >>= 1) {
    d[8 * size + k - (k < 7)] = 1 & f;
    d[(size - k) * size + 8] = 1 & f;
  }
}

function penalty(m) {
  const size = m.size, d = m.d;
  let score = 0, dark = 0;
  for (let n = 0; n < size; ++n) {
    for (let dirn = 0; dirn < 2; ++dirn) {
      for (let run = 0, l = 0, hist = 0, prev = 2; l < size; ++l) {
        const v = 1 & d[dirn ? n * size + l : l * size + n];
        dark += v;
        hist = ((hist >> 1) | 2098176) & (3047517 ^ (v - 1));
        if (2049 & hist) score += 40;
        if (v ^ prev) run = 0;
        prev = v;
        ++run;
        score += run === 5 ? 3 : run > 5 ? 1 : 0;
      }
    }
    if (n) {
      for (let i = size + n, a = (5 * d[n - 1]) ^ d[n]; i < size * size; i += size) {
        const b = (5 * d[i - 1]) ^ d[i];
        score += 3 * !((1 & (a | b)) | (4 & (a ^ b)));
        a = b;
      }
    }
  }
  return score + 10 * ((10 * Math.abs(dark / (size * size) - 1)) | 0);
}

function utf8(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00); i++; }
    }
    if (c >= 0xd800 && c < 0xe000) c = 0xfffd; // lone surrogate
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

const baseCache = [];
const LEVELS = { L: 0, M: 1, Q: 2, H: 3 };

function encode(text, level) {
  const data = utf8(String(text));
  const buf = bytes(2957);
  // ECI 26 (UTF-8) + byte mode header, then the length
  buf.set([113, 164, data.length >> 8]);
  for (let version = 1; version < 41; ++version) {
    let base = baseCache[version];
    if (!base) {
      base = baseCache[version] = newMatrix(4 * version + 17);
      drawFixed(base, version);
      base.positions = dataPositions(base);
    }
    const info = blockInfo(version, base.positions.length >> 3, level);
    if (info.dataBytes >= 3 + (version > 9) + data.length) {
      let o = version > 9 ? 3 : 2;
      buf[o++] = data.length;
      buf.set(data, o);
      for (o += data.length - 1; o < 2954; buf.set([236, 17], (o += 2)));
      const m = newMatrix(base.size, base.d);
      const cw = interleave(buf, info);
      base.positions.forEach((p, i) => { m.d[p] = (cw[i >> 3] >> (7 & ~i)) & 1; });
      let best = null;
      for (let k = 0; k < 8; k++) {
        const cand = newMatrix(m.size, m.d);
        applyMask(cand, MASKS[k], k, level);
        cand.score = penalty(cand);
        if (!best || cand.score < best.score) best = cand;
      }
      return best;
    }
  }
  throw new Error('qr: text too long');
}

// boolean[size][size], true = dark (no quiet zone)
export function qrMatrix(text, opts = {}) {
  const level = LEVELS[opts.level] != null ? LEVELS[opts.level] : 1;
  const m = encode(text, level);
  const rows = [];
  for (let y = 0; y < m.size; y++) {
    const row = [];
    for (let x = 0; x < m.size; x++) row.push((m.d[y * m.size + x] & 1) === 1);
    rows.push(row);
  }
  return rows;
}

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// SVG markup: one path of unit squares, viewBox in modules, crisp edges.
export function qrSVG(text, opts = {}) {
  const dark = opts.dark != null ? opts.dark : '#efeaf7';
  const light = opts.light != null ? opts.light : 'transparent';
  const border = opts.border != null ? Math.max(0, opts.border | 0) : 2;
  const rows = qrMatrix(text, opts);
  const n = rows.length + 2 * border;
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let w = 1;
      while (x + w < row.length && row[x + w]) w++;
      d += `M${x + border} ${y + border}h${w}v1h-${w}z`;
      x += w - 1;
    }
  });
  const bg = light && light !== 'transparent' && light !== 'none' ? `<rect width="${n}" height="${n}" fill="${escAttr(light)}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">${bg}<path fill="${escAttr(dark)}" d="${d}"/></svg>`;
}
