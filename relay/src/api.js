// Public API (exposed through Tailscale Funnel) + the loopback-only hook endpoint.
import http from 'node:http';
import crypto from 'node:crypto';
import { pubPermission } from './store.js';

const MAX_BODY = 16 * 1024;
const LOCK_FAILS = 10;
const GLOBAL_LOCK_FAILS = 50;
const LOCK_WINDOW_MS = 10 * 60_000;
const HEARTBEAT_MS = 15_000;

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { code: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { code: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export class Auth {
  constructor(token, now = () => Date.now()) {
    this.token = Buffer.from(token);
    this.now = now;
    this.fails = new Map(); // client -> [timestamps]
  }
  // The proxy (Tailscale Funnel) appends the real peer last; earlier entries are client-controlled.
  client(req) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return xff.at(-1) || req.socket.remoteAddress || '';
  }
  locked(req) {
    const t = this.now();
    let total = 0;
    for (const [k, list] of this.fails) {
      const live = list.filter((x) => t - x < LOCK_WINDOW_MS);
      if (live.length) this.fails.set(k, live);
      else this.fails.delete(k);
      total += live.length;
    }
    return total >= GLOBAL_LOCK_FAILS || (this.fails.get(this.client(req)) || []).length >= LOCK_FAILS;
  }
  check(req) {
    const h = req.headers.authorization || '';
    const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
    const ok = given.length === this.token.length && crypto.timingSafeEqual(given, this.token);
    // Stop recording once locked: keeps each list <= LOCK_FAILS and the map <= GLOBAL_LOCK_FAILS entries.
    if (!ok && !this.locked(req)) {
      const k = this.client(req);
      this.fails.set(k, [...(this.fails.get(k) || []), this.now()]);
    }
    return ok;
  }
}

/**
 * @param {{ store: import('./store.js').Store, hooks: import('./hooks.js').Hooks, token: string, log?: Function }} deps
 */
export function createApiServer({ store, hooks, token, log = () => {} }) {
  const auth = new Auth(token);
  const clients = new Set();

  const broadcast = (type, data, sessionId) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) if (!sessionId || !c.session || c.session === sessionId) c.res.write(msg);
  };
  // Only push event bodies to clients watching that session (or all-sessions clients).
  store.on('session', (s) => broadcast('session', s));
  store.on('event', ({ sessionId, event }) => {
    const msg = `event: event\ndata: ${JSON.stringify({ sessionId, event })}\n\n`;
    for (const c of clients) if (c.session === sessionId || c.session === '*') c.res.write(msg);
  });
  store.on('permission', (p) => broadcast('permission', pubPermission(p)));
  store.on('permission_resolved', (r) => broadcast('permission_resolved', r));
  store.on('away', (a) => broadcast('away', a));
  const heartbeat = setInterval(() => {
    for (const c of clients) c.res.write(`: ping ${Date.now()}\n\n`);
  }, HEARTBEAT_MS);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (url.pathname === '/api/health') return send(res, 200, { ok: true });
      if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });
      // A valid token always gets in; the lockout only throttles wrong guesses.
      if (!auth.check(req)) {
        if (auth.locked(req)) return send(res, 429, { error: 'too many failed attempts, try later' });
        log(`auth failed from ${auth.client(req)}`);
        return send(res, 401, { error: 'unauthorized' });
      }
      const route = `${req.method} /${parts.slice(1).map((p, i) => (i === 1 && parts[1] !== 'stream' && parts[1] !== 'state' && parts[1] !== 'away' ? ':id' : p)).join('/')}`;
      const id = parts[2];

      switch (route) {
        case 'GET /state':
          return send(res, 200, store.state());
        case 'GET /sessions/:id': {
          const before = Number(url.searchParams.get('before')) || Infinity;
          const limit = Math.min(Number(url.searchParams.get('limit')) || 80, 300);
          const feed = store.feed(id, { before, limit, thinking: url.searchParams.get('thinking') === '1' });
          return feed ? send(res, 200, feed) : send(res, 404, { error: 'no such session' });
        }
        case 'GET /stream': {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
          const c = { res, session: url.searchParams.get('session') || null };
          clients.add(c);
          res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify(store.state())}\n\n`);
          req.on('close', () => clients.delete(c));
          return;
        }
        case 'POST /permissions/:id': {
          const b = await readBody(req);
          if (b.behavior !== 'allow' && b.behavior !== 'deny') return send(res, 400, { error: 'behavior must be allow or deny' });
          const r = hooks.decide(id, { behavior: b.behavior, message: typeof b.message === 'string' ? b.message.slice(0, 2000) : undefined, always: !!b.always });
          if (r === 'gone') return send(res, 410, { error: 'This request was already answered.' });
          if (r === 'local') return send(res, 409, { error: 'Answer this one at the Mac (you were at your desk when it was asked).' });
          log(`permission ${id}: ${b.behavior}`);
          return send(res, 200, { ok: true });
        }
        case 'POST /sessions/:id/reply': {
          const b = await readBody(req);
          const text = typeof b.text === 'string' ? b.text.trim().slice(0, 4000) : '';
          if (!text) return send(res, 400, { error: 'text required' });
          const r = hooks.reply(id, text);
          if (r === 'idle') return send(res, 409, { error: 'Claude isn’t listening in this session. Replies work while it’s running or waiting (Away mode).' });
          return send(res, 200, { ok: true, result: r });
        }
        case 'POST /sessions/:id/stop':
          return hooks.requestStop(id) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'no such session' });
        case 'POST /away': {
          const b = await readBody(req);
          if (!['auto', 'away', 'desk'].includes(b.mode)) return send(res, 400, { error: 'mode must be auto, away or desk' });
          store.setAway({ mode: b.mode });
          await store.awayCheck?.();
          return send(res, 200, { ok: true, away: store.away });
        }
        default:
          return send(res, 404, { error: 'not found' });
      }
    } catch (e) {
      send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message });
    }
  });
  server.on('close', () => clearInterval(heartbeat));
  return server;
}

export function createHookServer({ hooks, secret, log = () => {} }) {
  if (!secret) throw new Error('hook secret missing; run `claudewatch install` again');
  const expected = Buffer.from(`/hook/${secret}`);
  return http.createServer(async (req, res) => {
    // Only Claude Code may call this: secret path, JSON body, and no browser Origin (blocks drive-by web pages).
    const p = Buffer.from(req.url || '');
    const pathOk = p.length === expected.length && crypto.timingSafeEqual(p, expected);
    const hostOk = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(req.headers.host || ''));
    if (req.method !== 'POST' || !pathOk || !hostOk || req.headers.origin || !String(req.headers['content-type'] || '').startsWith('application/json')) {
      return send(res, 404, {});
    }
    try {
      const payload = await readBody(req);
      const out = await hooks.handle(payload);
      if (Object.keys(out).length) log(`hook ${payload.hook_event_name} -> ${JSON.stringify(out).slice(0, 160)}`);
      send(res, 200, out);
    } catch (e) {
      log(`hook error: ${e.message}`);
      send(res, 200, {});
    }
  });
}
