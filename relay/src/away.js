// Decides whether the person is away from the Mac (so hooks may wait for the watch).
import { execFile } from 'node:child_process';

export function hidIdleSeconds() {
  return new Promise((resolve) => {
    execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 3000 }, (err, out) => {
      if (err) return resolve(0);
      const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
      resolve(m ? Number(m[1]) / 1e9 : 0);
    });
  });
}

/**
 * Keeps store.away up to date. mode: 'auto' | 'away' | 'desk'.
 * @param {import('./store.js').Store} store
 */
export function startAwayMonitor(store, { idleAwaySeconds, mode = 'auto', idle = hidIdleSeconds, intervalMs = 5000 }) {
  store.setAway({ mode });
  const check = async () => {
    const idleSeconds = Math.round(await idle());
    const m = store.away.mode;
    const effective = m === 'away' || (m === 'auto' && idleSeconds >= idleAwaySeconds);
    store.setAway({ effective, idleSeconds: m === 'auto' ? Math.min(idleSeconds, idleAwaySeconds) : 0 });
  };
  check();
  const t = setInterval(check, intervalMs);
  return { check, stop: () => clearInterval(t) };
}
