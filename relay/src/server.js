// Wires the relay together: transcripts -> store -> API, hooks -> store.
import { Store } from './store.js';
import { Transcripts } from './transcripts.js';
import { Hooks } from './hooks.js';
import { createApiServer, createHookServer } from './api.js';
import { startAwayMonitor } from './away.js';
import { makeNotifier } from './notify.js';

export async function startRelay(cfg, { log = console.log, idle, now } = {}) {
  if (!cfg.token) throw new Error('No token configured. Run `claudewatch install` first.');
  const store = new Store(now ? { now } : undefined);
  const transcripts = new Transcripts(store, cfg.projectsDir);
  const notify = makeNotifier(cfg.ntfy, log);
  const hooks = new Hooks(store, {
    holdSeconds: cfg.holdSeconds,
    notify: (n) => store.away.effective && notify(n),
    onActivity: (_id, file) => transcripts.poke(file),
  });
  const away = startAwayMonitor(store, { idleAwaySeconds: cfg.idleAwaySeconds, mode: cfg.awayMode, ...(idle ? { idle } : {}) });
  store.awayCheck = away.check;
  await transcripts.start();
  const ticker = setInterval(() => store.tick(), 5000);

  const api = createApiServer({ store, hooks, token: cfg.token, log });
  const hook = createHookServer({ hooks, secret: cfg.hookSecret, log });
  await Promise.all([
    new Promise((r, j) => api.once('error', j).listen(cfg.apiPort, '127.0.0.1', r)),
    new Promise((r, j) => hook.once('error', j).listen(cfg.hookPort, '127.0.0.1', r)),
  ]);
  log(`claudewatch relay: api 127.0.0.1:${api.address().port}, hooks 127.0.0.1:${hook.address().port}, ${store.sessions.size} sessions loaded`);

  return {
    store, hooks, api, hook,
    async close() {
      clearInterval(ticker);
      away.stop();
      transcripts.stop();
      hooks.releaseAll();
      api.closeAllConnections?.();
      hook.closeAllConnections?.();
      await Promise.all([new Promise((r) => api.close(r)), new Promise((r) => hook.close(r))]);
    },
  };
}
