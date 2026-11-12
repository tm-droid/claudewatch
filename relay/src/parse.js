// Pure transcript-line parsing: one JSONL entry -> zero or more watch events.
import path from 'node:path';

export const SNIPPET_MAX = 2000;
const TEXT_MAX = 8000;

const ICONS = {
  Bash: 'terminal', BashOutput: 'terminal', KillShell: 'xmark.octagon',
  Read: 'doc.text', Edit: 'pencil', MultiEdit: 'pencil', Write: 'square.and.pencil',
  NotebookEdit: 'book', Grep: 'magnifyingglass', Glob: 'folder',
  WebFetch: 'globe', WebSearch: 'globe', Agent: 'person.2', Task: 'person.2',
  Skill: 'sparkles', TodoWrite: 'checklist', ToolSearch: 'magnifyingglass',
  AskUserQuestion: 'questionmark.bubble', ExitPlanMode: 'list.bullet.clipboard',
};

// Wrapper tags Claude Code writes into "user" entries that the person did not type.
const SKIP_PREFIXES = [
  '<local-command-caveat>', '<local-command-stdout>', '<local-command-stderr>',
  '<system-reminder>', '<persisted-output>', '<bash-stdout>', '<bash-stderr>',
  '<task-notification>', '<command-message>', '<user-memory-input>',
];

export function clip(s, max) {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function firstLine(s) {
  return (s || '').split('\n').find((l) => l.trim())?.trim() ?? '';
}

function rel(p, cwd) {
  if (typeof p !== 'string') return '';
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  const home = process.env.HOME;
  return home && p.startsWith(home + '/') ? '~/' + p.slice(home.length + 1) : p;
}

export function iconFor(name) {
  if (ICONS[name]) return ICONS[name];
  if (name.startsWith('mcp__')) return 'puzzlepiece.extension';
  return 'wrench.and.screwdriver';
}

export function displayName(name) {
  if (!name.startsWith('mcp__')) return name;
  const [, server, ...rest] = name.split('__');
  const s = server.replace(/^plugin_[^_]+_/, '').replace(/^[0-9a-f-]{20,}$/, 'connector');
  return `${s} · ${rest.join('__')}`;
}

/** One-line summary + fuller detail for a tool call. */
export function describeTool(name, input = {}, cwd) {
  const i = input || {};
  switch (name) {
    case 'Bash':
      return { summary: i.description || clip(firstLine(i.command), 120), detail: i.command || '' };
    case 'Read':
      return { summary: rel(i.file_path, cwd), detail: rel(i.file_path, cwd) };
    case 'Write':
      return { summary: rel(i.file_path, cwd), detail: clip(i.content, SNIPPET_MAX) };
    case 'Edit':
      return {
        summary: rel(i.file_path, cwd),
        detail: clip(diff(i.old_string, i.new_string), SNIPPET_MAX),
      };
    case 'MultiEdit':
      return {
        summary: `${rel(i.file_path, cwd)} (${(i.edits || []).length} edits)`,
        detail: clip((i.edits || []).map((e) => diff(e.old_string, e.new_string)).join('\n…\n'), SNIPPET_MAX),
      };
    case 'Grep':
      return { summary: `"${i.pattern}"${i.path ? ' in ' + rel(i.path, cwd) : ''}`, detail: JSON.stringify(i, null, 1) };
    case 'Glob':
      return { summary: i.pattern || '', detail: i.path ? rel(i.path, cwd) : '' };
    case 'WebFetch':
      return { summary: i.url || '', detail: i.prompt || '' };
    case 'WebSearch':
      return { summary: i.query || '', detail: '' };
    case 'Agent':
    case 'Task':
      return { summary: i.description || i.subagent_type || 'Subagent', detail: clip(i.prompt, SNIPPET_MAX) };
    case 'Skill':
      return { summary: i.skill || '', detail: i.args || '' };
    case 'TodoWrite':
      return { summary: 'Updated todo list', detail: (i.todos || []).map((t) => `${t.status === 'completed' ? '✓' : '·'} ${t.content}`).join('\n') };
    default: {
      const firstStr = Object.values(i).find((v) => typeof v === 'string');
      return { summary: clip(firstLine(firstStr || ''), 120), detail: clip(JSON.stringify(i, null, 1), SNIPPET_MAX) };
    }
  }
}

function diff(a = '', b = '') {
  const minus = String(a).split('\n').map((l) => '- ' + l).join('\n');
  const plus = String(b).split('\n').map((l) => '+ ' + l).join('\n');
  return `${minus}\n${plus}`;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Turn a typed user string into a prompt text, or null if it is harness noise. */
export function promptText(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  if (SKIP_PREFIXES.some((p) => t.startsWith(p))) return null;
  const cmd = t.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return `${cmd[1].trim()}${args ? ' ' + args : ''}`;
  }
  const bash = t.match(/^<bash-input>([\s\S]*?)<\/bash-input>/);
  if (bash) return `! ${bash[1].trim()}`;
  if (t.startsWith('<') && /^<[a-z-]+>/.test(t) && t.includes('</')) return null;
  return clip(t, TEXT_MAX);
}

/**
 * Parse one transcript entry.
 * Returns { meta, events, results } where
 *  meta: { title?, aiTitle?, cwd?, ts? }
 *  events: new events [{ id, ts, kind, text?, tool? }]
 *  results: tool results [{ toolId, ok, text }]
 */
export function parseEntry(d) {
  const out = { meta: {}, events: [], results: [] };
  if (!d || typeof d !== 'object') return out;
  if (d.type === 'custom-title' && d.customTitle) out.meta.title = d.customTitle;
  if (d.type === 'ai-title' && d.aiTitle) out.meta.aiTitle = d.aiTitle;
  if (d.cwd) out.meta.cwd = d.cwd;
  const ts = d.timestamp ? Date.parse(d.timestamp) : undefined;
  if (ts) out.meta.ts = ts;
  if (d.type !== 'user' && d.type !== 'assistant') return out;
  if (d.isMeta) return out;
  const m = d.message;
  if (!m) return out;
  const base = d.uuid || d.message?.id || String(ts);

  if (d.type === 'user') {
    if (typeof m.content === 'string') {
      const text = promptText(m.content);
      if (text) out.events.push({ id: base, ts, kind: 'prompt', text });
      return out;
    }
    if (!Array.isArray(m.content)) return out;
    const texts = [];
    let images = 0;
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        out.results.push({ toolId: b.tool_use_id, ok: !b.is_error, text: clip(resultText(b.content), SNIPPET_MAX) });
      } else if (b.type === 'text') {
        const t = promptText(b.text);
        if (t) texts.push(t);
      } else if (b.type === 'image') images++;
    }
    if (texts.length || images) {
      const text = [texts.join('\n\n'), images ? `[${images} image${images > 1 ? 's' : ''}]` : ''].filter(Boolean).join('\n');
      out.events.push({ id: base, ts, kind: 'prompt', text });
    }
    return out;
  }

  // assistant: usually one content block per line; several share message.id.
  if (!Array.isArray(m.content)) return out;
  m.content.forEach((b, idx) => {
    const id = `${base}:${idx}`;
    if (b.type === 'text' && b.text?.trim()) {
      out.events.push({ id, ts, kind: 'text', text: clip(b.text.trim(), TEXT_MAX) });
    } else if (b.type === 'thinking' && b.thinking?.trim()) {
      out.events.push({ id, ts, kind: 'thinking', text: clip(b.thinking.trim(), SNIPPET_MAX) });
    } else if (b.type === 'tool_use') {
      const { summary, detail } = describeTool(b.name, b.input, d.cwd);
      out.events.push({
        id: b.id || id,
        ts,
        kind: 'tool',
        tool: { name: displayName(b.name), raw: b.name, icon: iconFor(b.name), summary: clip(summary, 200), detail, status: 'running' },
      });
    }
  });
  return out;
}

/** Map a transcript path to { sessionId, agentId? }. */
export function identify(file) {
  const base = path.basename(file, '.jsonl');
  const dir = path.dirname(file);
  if (path.basename(dir) === 'subagents') {
    return { sessionId: path.basename(path.dirname(dir)), agentId: base.replace(/^agent-/, '') };
  }
  return { sessionId: base };
}
