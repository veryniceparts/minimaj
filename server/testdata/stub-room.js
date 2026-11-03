// Minimal stand-in for js/room.js, used only when js/room.js is missing
// (lets the Go server and its tests run before the real room lands).
export const PROTO = 1;

export function createRoom(env) {
  const conns = new Map();
  const lobby = (id) => ({
    members: [...conns.values()].filter((c) => c.name).map((c) => ({ name: c.name, host: c.host, you: c.id === id, connected: true })),
    settings: { length: 1 }, isHost: !!(conns.get(id) || {}).host, max: 4,
  });
  const push = () => queueMicrotask(() => { for (const c of conns.values()) if (c.name) env.send(c.id, { t: 'lobby', lobby: lobby(c.id) }); });
  return {
    open(id, meta) { conns.set(id, { id, hostOk: !!(meta && meta.hostOk), name: null, host: false }); },
    message(id, m) {
      const c = conns.get(id);
      if (!c || !m || typeof m !== 'object') return;
      if (m.t === 'ping') return env.send(id, { t: 'pong', n: m.n });
      if (m.t === 'hello') {
        if (m.ver !== PROTO) { env.send(id, { t: 'error', msg: 'Please reload', fatal: true }); setTimeout(() => env.close(id), 300); return; }
        c.name = String(m.name || 'Player');
        c.host = !!m.host && c.hostOk;
        push();
        return;
      }
      env.send(id, { t: 'error', msg: 'Not supported by the stub room', fatal: false });
    },
    closed(id) { conns.delete(id); push(); },
    destroy() { conns.clear(); },
  };
}
