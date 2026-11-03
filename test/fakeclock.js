// Manual clock for tests: replaces the global setTimeout/clearTimeout/
// queueMicrotask with deterministic, synchronous versions.
export function installFakeClock() {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, queueMicrotask: globalThis.queueMicrotask };
  const timers = new Map(); // id -> { at, fn, args }
  const micro = [];
  let now = 0;
  let seq = 0;
  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    const id = ++seq;
    timers.set(id, { at: now + Math.max(0, +ms || 0), fn, args });
    return id;
  };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  globalThis.queueMicrotask = (fn) => { micro.push(fn); };

  const drain = () => { while (micro.length) micro.shift()(); };
  const next = () => {
    let id = 0, best = null;
    for (const [k, t] of timers) if (!best || t.at < best.at) { best = t; id = k; } // Map keeps insertion order: FIFO on ties
    return best ? [id, best] : null;
  };
  const clock = {
    now: () => now,
    pending: () => timers.size,
    drain,
    // run timers due within ms from now (and their microtasks)
    advance(ms) {
      drain();
      const end = now + ms;
      for (;;) {
        const n = next();
        if (!n || n[1].at > end) break;
        timers.delete(n[0]);
        if (n[1].at > now) now = n[1].at;
        n[1].fn(...n[1].args);
        drain();
      }
      now = end;
    },
    // run until no timers are left (or cond() becomes true)
    runAll(cond = () => false, maxSteps = 1e7) {
      drain();
      for (let i = 0; i < maxSteps && !cond(); i++) {
        const n = next();
        if (!n) return;
        timers.delete(n[0]);
        if (n[1].at > now) now = n[1].at;
        n[1].fn(...n[1].args);
        drain();
      }
    },
    uninstall() { Object.assign(globalThis, real); },
  };
  return clock;
}
