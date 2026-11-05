// Dev-only fake session (open the page with ?fake). Same API as js/net.js,
// over a local Game: you are seat 0, computer players sit in seats 1-3.
import { Game } from './game.js';
import { pickAnimals, pickAnimalExcept, ANIMAL_COUNT, MAX_REROLLS } from './room.js';

const q = new URLSearchParams(location.search);
const DELAY = +(q.get('delay') ?? 500);

export const normCode = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
export const codeProblem = (c) => (String(c || '').length === 5 ? null : 'Enter the 5-character room code.');
export async function detectServer() {
  if (q.has('online')) return null;
  return { server: true, version: 'fake', port: 7777, lanUrls: ['http://192.168.1.23:7777', 'http://10.0.0.5:7777'], hostOk: true };
}

export function createSession(opts, h) {
  let game = null;
  let settings = { length: +(q.get('len') || 1) };
  // ?animals=3,7,1,0 pins the mascots (screenshots); otherwise random like the room
  const pin = (q.get('animals') || '').split(',').map(Number);
  const pinned = pin.length === 4 && pin.every((x) => Number.isInteger(x) && x >= 0 && x < ANIMAL_COUNT) ? pin : null;
  let animal = pinned ? pinned[0] : pickAnimals(1)[0];
  let rerolls = 0;
  const lobby = () => ({
    members: [{ name: opts.name, host: true, you: true, connected: true, animal }],
    rerollsLeft: MAX_REROLLS - rerolls, maxRerolls: MAX_REROLLS,
    settings, isHost: true, max: 4, mode: opts.mode, code: opts.mode === 'online' ? 'FAKE5' : null,
    joinUrl: opts.mode === 'online' ? `${location.origin}${location.pathname}#FAKE5` : 'http://192.168.1.23:7777',
    lanUrls: ['http://192.168.1.23:7777', 'http://10.0.0.5:7777'],
  });
  let closed = false;
  // drop the game for good: its bot timers must not keep playing (or send views)
  const stop = () => { if (game) game.stop(); game = null; };
  let queued = false;
  const flush = (g) => {
    if (queued || g !== game) return;
    queued = true;
    queueMicrotask(() => { queued = false; if (game === g) h.onView({ ...structuredClone(g.view(0)), isHost: true }); });
  };
  setTimeout(() => { if (!closed) { h.onConn('open'); h.onLobby(lobby()); } }, 50);
  return {
    mode: opts.mode, cid: 'fake', isHost: true,
    act: (a) => game && game.act(0, a),
    start() {
      if (closed || game) return; // like the room: a second Start is ignored
      const names = ['Momo', 'Yuzu', 'Kiwi'];
      const an = [animal];
      for (let i = 1; i < 4; i++) an.push(pinned && !an.includes(pinned[i]) ? pinned[i] : pickAnimalExcept(an));
      const g = new Game([{ name: opts.name, kind: 'human' }, ...names.map((name) => ({ name, kind: 'bot' }))].map((p, i) => ({ ...p, animal: an[i] })),
        { length: settings.length, botDelay: DELAY, onChange: () => flush(g) });
      game = g;
      g.start();
    },
    setSettings(s) { if (closed) return; settings = { ...settings, ...s }; h.onLobby(lobby()); },
    backToLobby() { if (closed) return; stop(); rerolls = 0; h.onLobby(lobby()); },
    reroll() {
      if (closed || game) return;
      if (rerolls >= MAX_REROLLS) { h.onError('No rerolls left', false); return; }
      animal = pickAnimalExcept([animal]);
      rerolls++;
      h.onLobby(lobby());
    },
    playAgain() { if (closed) return; stop(); rerolls = 0; this.start(); },
    close() { closed = true; stop(); h.onConn('closed'); },
  };
}
