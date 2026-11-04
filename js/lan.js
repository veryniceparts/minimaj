// Local-network helpers for the minimaj app: short table codes and
// "tables nearby" discovery. Browser-only (uses fetch); no dependencies.
//
// Table codes use the same 32-symbol alphabet as room codes:
//   4 chars  = 192.168.x.y on the default port 7777
//   6 chars  = any private IPv4 (10/8, 172.16/12, 192.168/16) on ports 7777-7791
// (5-char codes are online PeerJS rooms, so the lengths never collide.)

const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const DEFAULT_PORT = 7777;

const enc = (n, len) => {
  let s = '';
  for (let i = 0; i < len; i++) { s = A[n % 32] + s; n = Math.floor(n / 32); }
  return s;
};
const dec = (s) => [...s].reduce((n, c) => n * 32 + A.indexOf(c), 0);

function octets(ip) {
  const o = String(ip).split('.').map(Number);
  return o.length === 4 && o.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? o : null;
}

// lanCode('192.168.1.23', 7777) -> 'AAJZ'; null if the address can't be coded.
export function lanCode(ip, port = DEFAULT_PORT) {
  const o = octets(ip);
  if (!o) return null;
  if (o[0] === 192 && o[1] === 168 && port === DEFAULT_PORT) return enc(o[2] * 256 + o[3], 4);
  let cls, host;
  if (o[0] === 10) { cls = 0; host = (o[1] << 16) | (o[2] << 8) | o[3]; }
  else if (o[0] === 172 && o[1] >= 16 && o[1] < 32) { cls = 1; host = ((o[1] - 16) << 16) | (o[2] << 8) | o[3]; }
  else if (o[0] === 192 && o[1] === 168) { cls = 2; host = (o[2] << 8) | o[3]; }
  else return null;
  const slot = port - DEFAULT_PORT;
  if (slot < 0 || slot > 14) return null;
  return enc(cls * 2 ** 28 + host * 16 + slot, 6);
}

export function parseLanCode(code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (![...c].every((ch) => A.includes(ch))) return null;
  if (c.length === 4) {
    const n = dec(c);
    if (n > 65535) return null;
    return { ip: `192.168.${n >> 8}.${n & 255}`, port: DEFAULT_PORT };
  }
  if (c.length !== 6) return null;
  const n = dec(c);
  const cls = Math.floor(n / 2 ** 28);
  const host = Math.floor(n / 16) % 2 ** 24;
  const port = DEFAULT_PORT + (n % 16);
  if (cls > 2 || port > DEFAULT_PORT + 14) return null;
  const b = [(host >> 16) & 255, (host >> 8) & 255, host & 255];
  const ip = cls === 0 ? `10.${b.join('.')}` : cls === 1 ? `172.${16 + b[0]}.${b[1]}.${b[2]}` : `192.168.${b[1]}.${b[2]}`;
  return { ip, port };
}

// The code for a join URL like "http://192.168.1.23:7777".
export function codeForUrl(url) {
  try { const u = new URL(url); return lanCode(u.hostname, +(u.port || 80)); } catch (e) { return null; }
}

// What the user typed -> a table URL, or null.
// Accepts a table code (AAJZ / AAAAXA), an IP ("192.168.1.23"), "ip:port", or a URL.
export function parseTableInput(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const code = parseLanCode(s);
  if (code && /^[a-z0-9]{4}$|^[a-z0-9]{6}$/i.test(s.replace(/[\s-]/g, ''))) return `http://${code.ip}:${code.port}`;
  const m = s.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{2,5}))?$/);
  if (m && octets(m[1])) return `http://${m[1]}:${m[2] || DEFAULT_PORT}`;
  return null;
}

// Probe one address; resolves to {url, info} or null. Needs the server's CORS header.
async function probe(url, ms) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = setTimeout(() => { if (ctrl) ctrl.abort(); }, ms);
  try {
    const r = await fetch(url + '/info.json', { cache: 'no-store', mode: 'cors', signal: ctrl ? ctrl.signal : undefined });
    if (!r.ok) return null;
    const info = await r.json();
    return info && info.server ? { url, info } : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Scan the /24 networks of our own LAN addresses for other minimaj tables.
// ownUrls: this app's lanUrls (e.g. ["http://192.168.1.23:7777"]). Calls
// onFound({url, code, info}) as tables answer; resolves when done.
export async function scanTables(ownUrls, onFound, { ms = 1500, parallel = 48, ports = [DEFAULT_PORT] } = {}) {
  const own = new Set();
  const nets = new Set();
  for (const u of ownUrls || []) {
    try {
      const h = new URL(u).hostname;
      const o = octets(h);
      if (!o) continue;
      own.add(h);
      nets.add(o.slice(0, 3).join('.'));
    } catch (e) { /* ignore */ }
  }
  const targets = [];
  for (const net of nets) {
    for (let i = 1; i < 255; i++) {
      const ip = `${net}.${i}`;
      if (own.has(ip)) continue;
      for (const p of ports) targets.push(`http://${ip}:${p}`);
    }
  }
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const url = targets[next++];
      const hit = await probe(url, ms);
      if (hit) {
        const u = new URL(url);
        onFound({ url, code: lanCode(u.hostname, +u.port), info: hit.info });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, targets.length) }, worker));
}
