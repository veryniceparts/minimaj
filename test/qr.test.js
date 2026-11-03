// Tests for js/qr.js. The hashes were produced once with lean-qr 2.7.4
// (nano build, minCorrectionLevel M), whose output js/qr.js reproduces exactly.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { qrMatrix, qrSVG } from '../js/qr.js';

const SNAPSHOTS = [
  ['http://192.168.1.23:7777', 25, '08b9dd95876f901b'],
  ['https://example.github.io/minimaj/#ABCDE', 29, 'e72070536bb5068b'],
  ['Hello, 世界! 🀄', 25, '5f85f6143712c415'],
  ['x'.repeat(100), 41, '46fca2ec2b4c1542'],
];

const hash = (m) => createHash('sha256').update(m.map((r) => r.map((b) => (b ? 1 : 0)).join('')).join('\n')).digest('hex').slice(0, 16);

export function runQrTests() {
  let n = 0;
  for (const [text, size, h] of SNAPSHOTS) {
    const m = qrMatrix(text);
    assert.equal(m.length, size, text);
    assert.ok(m.every((r) => r.length === size && r.every((b) => typeof b === 'boolean')));
    assert.equal(hash(m), h, 'qr matrix for ' + text);
    // finder patterns in three corners
    for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
      for (let i = 0; i < 7; i++) {
        assert.equal(m[oy][ox + i], true);
        assert.equal(m[oy + 6][ox + i], true);
        assert.equal(m[oy + 2][ox + 2 + (i % 3)], true);
      }
      assert.equal(m[oy + 1][ox + 1], false);
    }
  }
  n++;
  const svg = qrSVG('http://192.168.1.23:7777', { dark: '#000', light: '#fff', border: 4 });
  assert.ok(svg.startsWith('<svg') && svg.includes('viewBox="0 0 33 33"') && svg.includes('shape-rendering="crispEdges"'));
  assert.ok(svg.includes('fill="#fff"') && svg.includes('fill="#000"'));
  assert.ok(!qrSVG('a').includes('<rect'), 'transparent background by default');
  assert.ok(qrSVG('a').includes('fill="#efeaf7"'));
  n++;
  return n;
}
