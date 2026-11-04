// Tests for js/lan.js table codes and input parsing.
import assert from 'node:assert/strict';
import { lanCode, parseLanCode, parseTableInput, codeForUrl } from '../js/lan.js';

export function runLanTests() {
  let n = 0;
  const t = (name, fn) => { try { fn(); n++; } catch (e) { e.message = `lan: ${name}: ${e.message}`; throw e; } };

  t('codes round-trip', () => {
    const cases = [['192.168.1.23', 7777, 4], ['192.168.0.105', 7779, 6], ['10.0.0.42', 7777, 6],
      ['172.20.10.3', 7777, 6], ['192.168.43.1', 7777, 4], ['10.255.255.254', 7791, 6], ['172.31.0.1', 7780, 6]];
    for (const [ip, port, len] of cases) {
      const c = lanCode(ip, port);
      assert.equal(c.length, len, ip);
      assert.deepEqual(parseLanCode(c), { ip, port }, `${ip} -> ${c}`);
    }
    assert.equal(lanCode('192.168.1.23'), 'AAJZ');
    assert.equal(lanCode('8.8.8.8'), null);
    assert.equal(lanCode('10.0.0.1', 8080), null);
    assert.equal(codeForUrl('http://192.168.1.23:7777'), 'AAJZ');
    assert.equal(codeForUrl('http://localhost:7777'), null);
  });

  t('parse user input', () => {
    assert.equal(parseTableInput('aajz'), 'http://192.168.1.23:7777');
    assert.equal(parseTableInput(' AA-JZ '), 'http://192.168.1.23:7777');
    assert.equal(parseTableInput('192.168.1.50'), 'http://192.168.1.50:7777');
    assert.equal(parseTableInput('192.168.1.50:7778'), 'http://192.168.1.50:7778');
    assert.equal(parseTableInput('http://10.0.0.5:7777/#x'), 'http://10.0.0.5:7777');
    assert.equal(parseTableInput(''), null);
    assert.equal(parseTableInput('hello'), null);
    assert.equal(parseTableInput('999.1.1.1'), null);
    assert.equal(parseTableInput('AB'), null);
  });
  return n;
}
