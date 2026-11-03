// Dev-only fake session (open the page with ?fake). Same API as js/net.js,
// over a local Game: you are seat 0, computer players sit in seats 1-3.
import { Game } from './game.js';

const q = new URLSearchParams(location.search);
const DELAY = +(q.get('delay') ?? 500);

export const normCode = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
export async function detectServer() {
  if (q.has('online')) return null;
  return { server: true, version: 'fake', port: 7777, lanUrls: ['http://192.168.1.23:7777', 'http://10.0.0.5:7777'], hostOk: true };
}

export function createSession(opts, h) {
  let game = null;
  let settings = { length: +(q.get('len') || 1) };
  const lobby = () => ({
    members: [{ name: opts.name, host: true, you: true, connected: true }],
    settings, isHost: true, max: 4, mode: opts.mode, code: opts.mode === 'online' ? 'FAKE5' : null,
    joinUrl: opts.mode === 'online' ? `${location.origin}${location.pathname}#FAKE5` : 'http://192.168.1.23:7777',
    lanUrls: ['http://192.168.1.23:7777', 'http://10.0.0.5:7777'],
  });
  const stop = () => { if (game) game.scheduleBots = () => {}; game = null; };
  let queued = false;
  const flush = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; if (game) h.onView({ ...structuredClone(game.view(0)), isHost: true }); });
  };
  setTimeout(() => { h.onConn('open'); h.onLobby(lobby()); }, 50);
  return {
    mode: opts.mode, cid: 'fake', isHost: true,
    act: (a) => game && game.act(0, a),
    start() {
      const names = ['Momo', 'Yuzu', 'Kiwi'];
      game = new Game([{ name: opts.name, kind: 'human' }, ...names.map((name) => ({ name, kind: 'bot' }))],
        { length: settings.length, botDelay: DELAY, onChange: flush });
      game.start();
    },
    setSettings(s) { settings = { ...settings, ...s }; h.onLobby(lobby()); },
    backToLobby() { stop(); h.onLobby(lobby()); },
    close: stop,
  };
}
