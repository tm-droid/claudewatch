// In-memory model of all sessions, their event feeds, permissions and away state.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { clip, describeTool, iconFor, displayName } from './parse.js';

export const MAX_EVENTS = 600;
const RUNNING_STALE_MS = 15 * 60_000; // hook said running but nothing happened for this long
const ACTIVE_MS = 30_000; // transcript writes this recent => running (no hooks case)
const DONE_MS = 30 * 60_000; // finished within this => "done", else "idle"
const LIST_WINDOW_MS = 48 * 3600_000;

export class Store extends EventEmitter {
  constructor({ now = () => Date.now() } = {}) {
    super();
    this.now = now;
    this.sessions = new Map();
    this.permissions = new Map(); // id -> permission
    this.away = { mode: 'auto', effective: false, idleSeconds: 0 };
  }

  session(id) {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id, cwd: '', project: '', title: '', aiTitle: '', firstPrompt: '',
        events: [], byId: new Map(), seq: 0, lastActivity: 0,
        hookStatus: null, hookAt: 0, currentTool: null, listening: false,
        stopRequested: false, replies: [], status: 'idle', hooked: false,
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  // ---- transcript ingestion -------------------------------------------------

  applyMeta(id, meta, { live = true } = {}) {
    const s = this.session(id);
    if (meta.title) s.title = meta.title;
    if (meta.aiTitle) s.aiTitle = meta.aiTitle;
    if (meta.cwd && !s.cwd) {
      s.cwd = meta.cwd;
      s.project = path.basename(meta.cwd);
    }
    if (meta.ts && meta.ts > s.lastActivity) s.lastActivity = Math.min(meta.ts, this.now());
    if (live) this.touch(s);
  }

  addEvents(id, events, { parent = null, live = true } = {}) {
    const s = this.session(id);
    for (const e of events) {
      if (s.byId.has(e.id)) continue;
      const ev = { ...e, seq: ++s.seq };
      if (parent) ev.parent = parent;
      s.events.push(ev);
      s.byId.set(ev.id, ev);
      if (!s.firstPrompt && ev.kind === 'prompt' && !parent) s.firstPrompt = clip(ev.text.split('\n')[0], 80);
      if (parent) {
        const p = s.byId.get(parent);
        if (p?.tool) {
          p.tool.children = (p.tool.children || 0) + 1;
          if (live) this.emit('event', { sessionId: id, event: pub(p) });
        }
      }
      if (live) this.emit('event', { sessionId: id, event: pub(ev) });
    }
    while (s.events.length > MAX_EVENTS) s.byId.delete(s.events.shift().id);
    if (events.length && live) this.touch(s);
  }

  addResults(id, results, { live = true } = {}) {
    const s = this.session(id);
    for (const r of results) {
      const ev = s.byId.get(r.toolId);
      if (!ev?.tool) continue;
      ev.tool.status = r.ok ? 'ok' : 'error';
      ev.tool.result = r.text;
      if (live) this.emit('event', { sessionId: id, event: pub(ev) });
    }
  }

  // ---- hook-driven state ------------------------------------------------------

  hook(id, status, extra = {}) {
    const s = this.session(id);
    s.hooked = true;
    s.hookStatus = status;
    s.hookAt = this.now();
    if (extra.cwd && !s.cwd) {
      s.cwd = extra.cwd;
      s.project = path.basename(extra.cwd);
    }
    if ('currentTool' in extra) s.currentTool = extra.currentTool;
    this.touch(s);
    return s;
  }

  setListening(id, on) {
    const s = this.session(id);
    s.listening = on;
    this.touch(s);
  }

  addPermission(p) {
    this.permissions.set(p.id, p);
    this.emit('permission', p);
    this.touch(this.session(p.sessionId));
  }

  updatePermission(id, patch) {
    const p = this.permissions.get(id);
    if (!p) return;
    Object.assign(p, patch);
    this.emit('permission', p);
  }

  resolvePermission(id, outcome) {
    const p = this.permissions.get(id);
    if (!p) return;
    this.permissions.delete(id);
    this.emit('permission_resolved', { id, sessionId: p.sessionId, outcome });
    this.touch(this.session(p.sessionId));
  }

  /** Permission requests for a session are over once anything else happens there. */
  clearPermissions(sessionId, outcome = 'answered_at_mac') {
    for (const p of [...this.permissions.values()]) {
      if (p.sessionId === sessionId && !p.waiter) this.resolvePermission(p.id, outcome);
    }
  }

  setAway(patch) {
    const before = JSON.stringify(this.away);
    Object.assign(this.away, patch);
    if (JSON.stringify(this.away) !== before) this.emit('away', { ...this.away });
  }

  // ---- views ------------------------------------------------------------------

  computeStatus(s) {
    const now = this.now();
    if ([...this.permissions.values()].some((p) => p.sessionId === s.id)) return 'needs_you';
    if (s.listening) return 'listening';
    if (s.hookStatus === 'running' && now - Math.max(s.lastActivity, s.hookAt) < RUNNING_STALE_MS) return 'running';
    if (!s.hooked || s.hookStatus === 'running') {
      if (now - s.lastActivity < ACTIVE_MS) return 'running';
    }
    if (s.hookStatus === 'ended') return 'idle';
    return now - Math.max(s.lastActivity, s.hookAt) < DONE_MS ? 'done' : 'idle';
  }

  touch(s) {
    s.status = this.computeStatus(s);
    this.emit('session', this.summary(s));
  }

  /** Re-evaluate time-based status changes; emits only what changed. */
  tick() {
    for (const s of this.sessions.values()) {
      const st = this.computeStatus(s);
      if (st !== s.status) {
        s.status = st;
        if (st !== 'running') s.currentTool = null;
        this.emit('session', this.summary(s));
      }
    }
  }

  summary(s) {
    let preview = '';
    for (let i = s.events.length - 1; i >= 0; i--) {
      const e = s.events[i];
      if (e.parent || e.kind === 'thinking') continue;
      preview = e.kind === 'tool' ? `${e.tool.name}: ${e.tool.summary}` : e.text.split('\n').find((l) => l.trim()) || '';
      break;
    }
    return {
      id: s.id,
      project: s.project || 'unknown',
      cwd: s.cwd,
      title: s.title || s.aiTitle || s.firstPrompt || 'New session',
      status: s.status,
      lastActivity: Math.max(s.lastActivity, s.hookAt),
      preview: clip(preview, 140),
      currentTool: s.status === 'running' ? s.currentTool : null,
      canReply: s.status === 'running' || s.status === 'listening' || s.status === 'needs_you',
      stopRequested: s.stopRequested,
      queuedReplies: s.replies.length,
    };
  }

  listSessions() {
    const now = this.now();
    const order = { needs_you: 0, listening: 1, running: 2, done: 3, idle: 4 };
    return [...this.sessions.values()]
      // Hook-only sessions (claude -p, SDK runs, blank starts) show only while they need attention.
      .filter((s) => s.events.length || (s.hooked && ['needs_you', 'listening', 'running'].includes(s.status)))
      .filter((s) => s.status !== 'idle' || now - s.lastActivity < LIST_WINDOW_MS)
      .map((s) => this.summary(s))
      .sort((a, b) => order[a.status] - order[b.status] || b.lastActivity - a.lastActivity);
  }

  feed(id, { before = Infinity, limit = 80, thinking = false } = {}) {
    const s = this.sessions.get(id);
    if (!s) return null;
    const evs = s.events.filter((e) => e.seq < before && (thinking || e.kind !== 'thinking'));
    const page = evs.slice(-limit);
    return { session: this.summary(s), events: page.map(pub), hasMore: evs.length > page.length };
  }

  state() {
    return {
      away: { ...this.away },
      sessions: this.listSessions(),
      permissions: [...this.permissions.values()].map(pubPermission),
      serverTime: this.now(),
    };
  }
}

export function pub(e) {
  const out = { id: e.id, seq: e.seq, ts: e.ts || 0, kind: e.kind };
  if (e.text !== undefined) out.text = e.text;
  if (e.parent) out.parent = e.parent;
  if (e.via) out.via = e.via;
  if (e.tool) {
    out.tool = { name: e.tool.name, icon: e.tool.icon, summary: e.tool.summary, detail: e.tool.detail || '', status: e.tool.status };
    if (e.tool.result !== undefined) out.tool.result = e.tool.result;
    if (e.tool.children) out.tool.children = e.tool.children;
  }
  return out;
}

export function pubPermission(p) {
  return {
    id: p.id, sessionId: p.sessionId, project: p.project, tool: p.tool, icon: p.icon,
    summary: p.summary, detail: p.detail, ts: p.ts, remote: !!p.waiter,
    suggestions: p.suggestions || [],
  };
}

export function toolCard(toolName, toolInput, cwd) {
  const { summary, detail } = describeTool(toolName, toolInput, cwd);
  return { tool: displayName(toolName), icon: iconFor(toolName), summary: clip(summary, 200), detail };
}
