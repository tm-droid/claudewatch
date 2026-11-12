// Tails every Claude Code transcript under ~/.claude/projects and feeds the store.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseEntry, identify } from './parse.js';

const INITIAL_WINDOW_MS = 48 * 3600_000;
const INITIAL_TAIL_BYTES = 3 * 1024 * 1024;
const SWEEP_MS = 10_000;

export class Transcripts {
  constructor(store, root) {
    this.store = store;
    this.root = root;
    this.files = new Map(); // file -> { offset, partial, sessionId, parent, firstPromptSkipped }
    this.pending = new Set();
    this.timer = null;
    this.reading = Promise.resolve();
  }

  async start() {
    await this.sweep({ initial: true });
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_t, name) => {
        if (name && name.endsWith('.jsonl')) this.schedule(path.join(this.root, name));
      });
    } catch {
      // fs.watch unavailable: the periodic sweep still picks everything up.
    }
    this.sweeper = setInterval(() => this.sweep().catch(() => {}), SWEEP_MS);
  }

  stop() {
    this.watcher?.close();
    clearInterval(this.sweeper);
    clearTimeout(this.timer);
  }

  /** Force-read a transcript path reported by a hook. */
  poke(file) {
    if (file && file.startsWith(this.root)) this.schedule(file);
  }

  schedule(file) {
    this.pending.add(file);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        const batch = [...this.pending];
        this.pending.clear();
        this.reading = this.reading.then(() => Promise.all(batch.map((f) => this.read(f, { live: true }))).catch(() => {}));
      }, 60);
    }
  }

  async listFiles() {
    const out = [];
    const projects = await fsp.readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const dir = path.join(this.root, p.name);
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(dir, e.name));
        else if (e.isDirectory() && e.name !== 'memory') {
          const sub = path.join(dir, e.name, 'subagents');
          const subs = await fsp.readdir(sub).catch(() => []);
          for (const s of subs) if (s.endsWith('.jsonl')) out.push(path.join(sub, s));
        }
      }
    }
    return out;
  }

  async sweep({ initial = false } = {}) {
    const files = await this.listFiles();
    const cutoff = Date.now() - INITIAL_WINDOW_MS;
    const stats = await Promise.all(files.map((f) => fsp.stat(f).then((s) => [f, s]).catch(() => null)));
    // Parents before subagents so Agent tool events exist when children arrive.
    const todo = stats
      .filter(Boolean)
      .filter(([f, st]) => {
        const known = this.files.get(f);
        if (known) return st.size !== known.offset;
        return st.mtimeMs >= cutoff;
      })
      .sort(([a], [b]) => Number(a.includes('/subagents/')) - Number(b.includes('/subagents/')));
    for (const [f] of todo) await this.read(f, { live: !initial });
  }

  async meta(file) {
    const metaFile = file.replace(/\.jsonl$/, '.meta.json');
    try {
      return JSON.parse(await fsp.readFile(metaFile, 'utf8'));
    } catch {
      return {};
    }
  }

  async read(file, { live }) {
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      return;
    }
    let f = this.files.get(file);
    if (!f) {
      const { sessionId, agentId } = identify(file);
      const meta = agentId ? await this.meta(file) : {};
      const start = Math.max(0, st.size - INITIAL_TAIL_BYTES);
      // A brand-new transcript file seen live is read from the top.
      const offset = live ? 0 : start;
      f = {
        offset, partial: '', sessionId, parent: agentId ? meta.toolUseId || null : null,
        isAgent: !!agentId, skipFirstPrompt: !!agentId && offset === 0, trimHead: offset > 0,
      };
      this.files.set(file, f);
    }
    if (st.size < f.offset) {
      f.offset = 0;
      f.partial = '';
    }
    if (st.size === f.offset) return;
    const fh = await fsp.open(file, 'r');
    try {
      const len = st.size - f.offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, f.offset);
      f.offset = st.size;
      let text = f.partial + buf.toString('utf8');
      if (f.trimHead) {
        text = text.slice(text.indexOf('\n') + 1);
        f.trimHead = false;
      }
      const lines = text.split('\n');
      f.partial = lines.pop() ?? '';
      this.ingest(f, lines, live);
    } finally {
      await fh.close();
    }
  }

  ingest(f, lines, live) {
    const { store } = this;
    const events = [];
    const results = [];
    const meta = {};
    for (const line of lines) {
      if (!line) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const r = parseEntry(d);
      if (!f.isAgent) Object.assign(meta, r.meta);
      else if (r.meta.ts) meta.ts = r.meta.ts;
      for (const e of r.events) {
        if (f.skipFirstPrompt && e.kind === 'prompt') {
          f.skipFirstPrompt = false;
          continue;
        }
        events.push(e);
      }
      results.push(...r.results);
    }
    store.applyMeta(f.sessionId, meta, { live: false });
    store.addEvents(f.sessionId, events, { parent: f.parent, live });
    store.addResults(f.sessionId, results, { live });
    if (live) store.touch(store.session(f.sessionId));
    else store.session(f.sessionId).status = store.computeStatus(store.session(f.sessionId));
  }
}
