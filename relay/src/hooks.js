// Handles Claude Code "http" hook calls. Each returns the JSON Claude Code should act on ({} = no opinion).
import crypto from 'node:crypto';
import { toolCard } from './store.js';

export const STOP_REASON = 'Stopped from Apple Watch';

export class Hooks {
  /**
   * @param {import('./store.js').Store} store
   * @param {{ holdSeconds: number, notify?: (n: {title: string, body: string, priority?: string, tags?: string}) => void, onActivity?: (sessionId: string, transcriptPath?: string) => void }} opts
   */
  constructor(store, opts) {
    this.store = store;
    this.holdMs = opts.holdSeconds * 1000;
    this.notify = opts.notify || (() => {});
    this.onActivity = opts.onActivity || (() => {});
    this.listeners = new Map(); // sessionId -> resolve(replyText|null)
    store.on('away', (a) => {
      if (!a.effective) this.releaseAll();
    });
  }

  /** Free anything held for this session: a Stop hold, permission waiters and queued replies. */
  release(id) {
    this.listeners.get(id)?.(null);
    for (const p of this.store.permissions.values()) if (p.sessionId === id && p.waiter) p.waiter(null);
    const s = this.store.sessions.get(id);
    if (s) s.replies = [];
  }

  /** `signal` aborts when Claude Code drops the hook request (answered at the Mac, Ctrl-C, exit). */
  async handle(p, signal) {
    const id = p.session_id;
    if (!id) return {};
    const ev = p.hook_event_name;
    this.onActivity(id, p.transcript_path);
    const s = this.store.session(id);
    const extra = { cwd: p.cwd };

    switch (ev) {
      case 'SessionStart':
        this.store.hook(id, 'done', extra);
        return {};
      case 'UserPromptSubmit':
        // A new prompt means any earlier hold or queued reply is stale.
        this.release(id);
        s.stopRequested = false;
        this.store.clearPermissions(id);
        this.store.hook(id, 'running', { ...extra, currentTool: null });
        return {};
      case 'PreToolUse': {
        if (s.stopRequested) return this.stopOutput(id);
        this.store.clearPermissions(id);
        const card = toolCard(p.tool_name, p.tool_input, p.cwd);
        this.store.hook(id, 'running', { ...extra, currentTool: { name: card.tool, icon: card.icon, summary: card.summary, since: Date.now() } });
        return {};
      }
      case 'PostToolUse':
      case 'PostToolUseFailure':
        if (s.stopRequested) return this.stopOutput(id);
        this.store.clearPermissions(id);
        this.store.hook(id, 'running', { ...extra, currentTool: null });
        return {};
      case 'PermissionRequest':
        return this.permission(p, signal);
      case 'Notification':
        if (p.notification_type === 'permission_prompt' && ![...this.store.permissions.values()].some((x) => x.sessionId === id)) {
          // Hosts that skip PermissionRequest (e.g. SDK canUseTool) still tell us someone is needed.
          this.store.addPermission({
            id: 'n-' + crypto.randomUUID(), sessionId: id, project: s.project, tool: 'Permission',
            icon: 'hand.raised', summary: p.message || 'Claude needs your permission', detail: '', ts: Date.now(),
          });
        }
        return {};
      case 'Stop':
        return this.stop(p, signal);
      case 'SessionEnd':
        this.release(id);
        this.store.clearPermissions(id, 'session_ended');
        this.store.hook(id, 'ended', { currentTool: null });
        return {};
      default:
        return {};
    }
  }

  stopOutput(id) {
    const s = this.store.session(id);
    s.stopRequested = false;
    this.store.hook(id, 'done', { currentTool: null });
    return { continue: false, stopReason: STOP_REASON };
  }

  async permission(p, signal) {
    const id = p.session_id;
    const s = this.store.session(id);
    const card = toolCard(p.tool_name, p.tool_input, p.cwd);
    const perm = {
      id: crypto.randomUUID(), sessionId: id, project: s.project, ...card, ts: Date.now(),
      suggestions: Array.isArray(p.permission_suggestions) ? p.permission_suggestions : [],
    };
    if (s.stopRequested) return this.stopOutput(id);
    this.store.hook(id, 'running', { cwd: p.cwd, currentTool: null });
    if (!this.store.away.effective) {
      this.store.addPermission(perm); // shown on the watch as "answer at Mac"
      return {};
    }
    const decision = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), this.holdMs);
      perm.waiter = (d) => {
        clearTimeout(timer);
        resolve(d);
      };
      signal?.addEventListener('abort', () => perm.waiter?.(null), { once: true });
      this.store.addPermission(perm);
      this.notify({ title: `${s.project || 'Claude'} needs permission`, body: `${card.tool}: ${card.summary}`.slice(0, 120), priority: 'high', tags: 'warning' });
    });
    if (!decision) {
      delete perm.waiter;
      // Claude Code dropped the request (answered at the Mac, Ctrl-C): nothing left to answer.
      if (signal?.aborted) this.store.resolvePermission(perm.id, 'answered_at_mac');
      // Timed out or person came back to the Mac: hand over to the normal dialog.
      else this.store.updatePermission(perm.id, {});
      return {};
    }
    this.store.resolvePermission(perm.id, decision.behavior);
    const out = { behavior: decision.behavior };
    if (decision.behavior === 'deny') {
      out.message = decision.message || 'Denied from Apple Watch';
      if (decision.interrupt) {
        out.interrupt = true;
        s.stopRequested = false;
      }
    }
    if (decision.behavior === 'allow' && decision.always && perm.suggestions.length) out.updatedPermissions = perm.suggestions;
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: out } };
  }

  /** Called by the API when the watch answers. Returns false if nobody is waiting. */
  decide(permId, decision) {
    const p = this.store.permissions.get(permId);
    if (!p) return 'gone';
    if (!p.waiter) return 'local';
    p.waiter(decision);
    return 'ok';
  }

  async stop(p, signal) {
    const id = p.session_id;
    const s = this.store.session(id);
    this.store.clearPermissions(id);
    if (s.stopRequested) {
      s.stopRequested = false;
      this.store.hook(id, 'done', { currentTool: null });
      return {};
    }
    if (s.replies.length) return this.deliver(id, s.replies.splice(0).join('\n\n'));
    if (!this.store.away.effective) {
      this.store.hook(id, 'done', { currentTool: null });
      return {};
    }
    this.store.hook(id, 'done', { currentTool: null });
    this.notify({ title: `${s.project || 'Claude'} finished`, body: 'Reply from your watch to keep going.', tags: 'white_check_mark' });
    const reply = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), this.holdMs);
      this.listeners.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      signal?.addEventListener('abort', () => this.listeners.get(id)?.(null), { once: true });
      this.store.setListening(id, true);
    });
    this.listeners.delete(id);
    this.store.setListening(id, false);
    if (!reply) {
      this.store.hook(id, 'done', { currentTool: null });
      return {};
    }
    return this.deliver(id, reply);
  }

  deliver(id, text) {
    // The block reason never lands in the transcript as a user line, so show it in the feed ourselves.
    this.store.addEvents(id, [{ id: 'w-' + crypto.randomUUID(), ts: Date.now(), kind: 'prompt', text, via: 'watch' }]);
    this.store.hook(id, 'running', { currentTool: null });
    return { decision: 'block', reason: `Message from the user (sent from their Apple Watch): ${text}` };
  }

  /** Queue or hand over a reply. Returns 'delivered' | 'queued' | 'idle'. */
  reply(id, text) {
    const s = this.store.sessions.get(id);
    if (!s) return 'idle';
    // Replies only reach Claude through the Stop hook; sessions without hooks would queue forever.
    if (!s.hooked) return 'idle';
    const l = this.listeners.get(id);
    if (l) {
      l(text);
      return 'delivered';
    }
    const status = this.store.computeStatus(s);
    if (status === 'running' || status === 'needs_you') {
      s.replies.push(text);
      this.store.touch(s);
      return 'queued';
    }
    return 'idle';
  }

  requestStop(id) {
    const s = this.store.sessions.get(id);
    if (!s) return false;
    const l = this.listeners.get(id);
    if (l) {
      l(null);
      return true;
    }
    s.stopRequested = true;
    s.replies = [];
    for (const p of this.store.permissions.values()) {
      if (p.sessionId === id && p.waiter) p.waiter({ behavior: 'deny', message: STOP_REASON, interrupt: true });
    }
    this.store.touch(s);
    return true;
  }

  releaseAll() {
    for (const l of this.listeners.values()) l(null);
    for (const p of this.store.permissions.values()) if (p.waiter) p.waiter(null);
  }
}
