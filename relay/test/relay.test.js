import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEntry, promptText, describeTool, displayName } from '../src/parse.js';
import { Store } from '../src/store.js';
import { Hooks, STOP_REASON } from '../src/hooks.js';
import { Transcripts } from '../src/transcripts.js';
import { startRelay } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => path.join(here, 'fixtures', n);
const CONTRACT_DIR = path.join(here, '..', '..', 'fixtures', 'api');

function projectsDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-'));
  const proj = path.join(root, '-Users-me-proj-app');
  fs.mkdirSync(path.join(proj, 's1', 'subagents'), { recursive: true });
  fs.copyFileSync(fx('main.jsonl'), path.join(proj, 's1.jsonl'));
  fs.copyFileSync(fx('agent.jsonl'), path.join(proj, 's1', 'subagents', 'agent-ag1.jsonl'));
  fs.copyFileSync(fx('agent.meta.json'), path.join(proj, 's1', 'subagents', 'agent-ag1.meta.json'));
  return { root, main: path.join(proj, 's1.jsonl') };
}

test('promptText filters harness wrappers and formats commands', () => {
  assert.equal(promptText('<system-reminder>x</system-reminder>'), null);
  assert.equal(promptText('<task-notification>x</task-notification>'), null);
  assert.equal(promptText('<command-name>/compact</command-name>\n<command-args>keep</command-args>'), '/compact keep');
  assert.equal(promptText('<bash-input>ls</bash-input>'), '! ls');
  assert.equal(promptText('hello <b>world</b>'), 'hello <b>world</b>');
});

test('describeTool summaries', () => {
  assert.equal(describeTool('Bash', { command: 'npm test', description: 'Run tests' }).summary, 'Run tests');
  assert.equal(describeTool('Read', { file_path: '/a/b/c.js' }, '/a').summary, 'b/c.js');
  assert.match(describeTool('Edit', { file_path: '/a/x', old_string: 'a', new_string: 'b' }, '/a').detail, /- a\n\+ b/);
  assert.equal(displayName('mcp__plugin_context-mode_context-mode__ctx_search'), 'context-mode · ctx_search');
});

test('parseEntry: tool_use and tool_result', () => {
  const lines = fs.readFileSync(fx('main.jsonl'), 'utf8').trim().split('\n').map((l) => parseEntry(JSON.parse(l)));
  const evs = lines.flatMap((l) => l.events);
  assert.deepEqual(evs.map((e) => e.kind), ['prompt', 'thinking', 'text', 'tool', 'tool', 'tool', 'prompt', 'tool', 'text']);
  assert.equal(evs[3].tool.summary, 'Run auth tests');
  assert.equal(evs[4].tool.summary, 'src/auth.js');
  const results = lines.flatMap((l) => l.results);
  assert.deepEqual(results.map((r) => r.ok), [false, true]);
});

test('transcripts -> store: titles, results, subagent grouping, contract fixtures', async () => {
  const { root } = projectsDir();
  const store = new Store({ now: () => Date.parse('2026-11-12T10:00:20Z') });
  const t = new Transcripts(store, root);
  await t.sweep({ initial: true });
  const s = store.listSessions()[0];
  assert.equal(s.title, 'Login fix');
  assert.equal(s.project, 'app');
  assert.equal(s.preview, 'Fixed. Tests pass.');
  assert.equal(s.status, 'running'); // written 9 s ago, no hooks
  const feed = store.feed('s1');
  const bash = feed.events.find((e) => e.id === 'toolu_1');
  assert.equal(bash.tool.status, 'error');
  assert.equal(bash.tool.result, '1 failing');
  const agent = feed.events.find((e) => e.id === 'toolu_3');
  assert.equal(agent.tool.children, 2);
  const children = feed.events.filter((e) => e.parent === 'toolu_3');
  assert.deepEqual(children.map((e) => e.kind), ['tool', 'text']); // delegation prompt skipped
  assert.ok(!feed.events.some((e) => e.kind === 'thinking'));
  assert.ok(store.feed('s1', { thinking: true }).events.some((e) => e.kind === 'thinking'));

  // Contract fixtures consumed by the Swift tests.
  fs.mkdirSync(CONTRACT_DIR, { recursive: true });
  const state = store.state();
  state.permissions = [{ id: 'p1', sessionId: 's1', project: 'app', tool: 'Bash', icon: 'terminal', summary: 'Run auth tests', detail: 'npm test -- auth', ts: 1, remote: true, suggestions: [] }];
  fs.writeFileSync(path.join(CONTRACT_DIR, 'state.json'), JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(CONTRACT_DIR, 'feed.json'), JSON.stringify(store.feed('s1', { thinking: true }), null, 2));
});

test('transcripts: appended lines are picked up live', async () => {
  const { root, main } = projectsDir();
  const store = new Store();
  const t = new Transcripts(store, root);
  await t.sweep({ initial: true });
  const seen = [];
  store.on('event', (e) => seen.push(e.event));
  fs.appendFileSync(main, JSON.stringify({ type: 'assistant', uuid: 'a9', timestamp: new Date().toISOString(), sessionId: 's1', message: { id: 'm', content: [{ type: 'text', text: 'Live!' }] } }) + '\n');
  await t.sweep();
  assert.equal(seen.at(-1).text, 'Live!');
});

function hookSetup({ away = false, hold = 5 } = {}) {
  const store = new Store();
  store.setAway({ mode: away ? 'away' : 'desk', effective: away });
  const notes = [];
  const hooks = new Hooks(store, { holdSeconds: hold, notify: (n) => notes.push(n) });
  const base = { session_id: 's1', cwd: '/Users/me/proj/app', transcript_path: '/x' };
  return { store, hooks, notes, base };
}

test('PermissionRequest at desk: returns immediately, watch sees it, cleared by next tool', async () => {
  const { store, hooks, base } = hookSetup();
  const out = await hooks.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  assert.deepEqual(out, {});
  const [p] = store.state().permissions;
  assert.equal(p.remote, false);
  assert.equal(p.detail, 'rm -rf build');
  assert.equal(hooks.decide(p.id, { behavior: 'allow' }), 'local');
  assert.equal(store.listSessions()[0].status, 'needs_you');
  await hooks.handle({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.equal(store.state().permissions.length, 0);
});

test('PermissionRequest when away: waits for watch decision', async () => {
  const { store, hooks, base, notes } = hookSetup({ away: true });
  const pending = hooks.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [{ type: 'addRules' }] });
  await new Promise((r) => setImmediate(r));
  const [p] = store.state().permissions;
  assert.equal(p.remote, true);
  assert.equal(notes[0].priority, 'high');
  assert.equal(hooks.decide(p.id, { behavior: 'allow', always: true }), 'ok');
  const out = await pending;
  assert.deepEqual(out.hookSpecificOutput.decision, { behavior: 'allow', updatedPermissions: [{ type: 'addRules' }] });
  assert.equal(store.state().permissions.length, 0);
});

test('PermissionRequest when away: deny with message; timeout falls back to Mac dialog', async () => {
  const { store, hooks, base } = hookSetup({ away: true, hold: 0.05 });
  const pending = hooks.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
  await new Promise((r) => setImmediate(r));
  hooks.decide(store.state().permissions[0].id, { behavior: 'deny', message: 'use pnpm' });
  assert.deepEqual((await pending).hookSpecificOutput.decision, { behavior: 'deny', message: 'use pnpm' });
  const out = await hooks.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.deepEqual(out, {});
  assert.equal(store.state().permissions[0].remote, false); // now answer-at-Mac
});

test('coming back to the desk releases a waiting permission', async () => {
  const { store, hooks, base } = hookSetup({ away: true });
  const pending = hooks.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
  await new Promise((r) => setImmediate(r));
  store.setAway({ effective: false });
  assert.deepEqual(await pending, {});
});

test('Stop when away: listens, reply continues Claude', async () => {
  const { store, hooks, base } = hookSetup({ away: true });
  await hooks.handle({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  const pending = hooks.handle({ ...base, hook_event_name: 'Stop', stop_hook_active: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(store.listSessions()[0].status, 'listening');
  assert.equal(hooks.reply('s1', 'now run the tests'), 'delivered');
  const out = await pending;
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /now run the tests/);
  assert.equal(store.listSessions()[0].status, 'running');
});

test('reply while running is queued and delivered at Stop (at desk)', async () => {
  const { hooks, base } = hookSetup();
  await hooks.handle({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  assert.equal(hooks.reply('s1', 'also update docs'), 'queued');
  const out = await hooks.handle({ ...base, hook_event_name: 'Stop' });
  assert.match(out.reason, /also update docs/);
  assert.deepEqual(await hooks.handle({ ...base, hook_event_name: 'Stop' }), {});
  assert.equal(hooks.reply('s1', 'late'), 'idle');
});

test('dropped hook request frees the permission and the Stop hold', async () => {
  const { store, hooks, base } = hookSetup({ away: true });
  await hooks.handle({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  const ac = new AbortController();
  const pending = hooks.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }, ac.signal);
  await new Promise((r) => setImmediate(r));
  const [p] = store.state().permissions;
  ac.abort(); // answered at the Mac
  assert.deepEqual(await pending, {});
  assert.equal(store.state().permissions.length, 0);
  assert.equal(hooks.decide(p.id, { behavior: 'allow' }), 'gone');

  const ac2 = new AbortController();
  const stop = hooks.handle({ ...base, hook_event_name: 'Stop' }, ac2.signal);
  await new Promise((r) => setImmediate(r));
  ac2.abort();
  assert.deepEqual(await stop, {});
  assert.notEqual(store.computeStatus(store.sessions.get('s1')), 'listening');
});

test('new prompt clears stale replies; no replies or listing for hook-only sessions without hooks', async () => {
  const { store, hooks, base } = hookSetup();
  await hooks.handle({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  assert.equal(hooks.reply('s1', 'old note'), 'queued');
  await hooks.handle({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'next' }); // Esc, then typed at the Mac
  assert.deepEqual(await hooks.handle({ ...base, hook_event_name: 'Stop' }), {});

  store.session('t1'); // transcript-only session (no hooks)
  store.touch(store.sessions.get('t1'));
  assert.equal(hooks.reply('t1', 'hello'), 'idle');

  await hooks.handle({ ...base, session_id: 'p1', hook_event_name: 'SessionStart' }); // claude -p start, no events
  assert.ok(!store.listSessions().some((x) => x.id === 'p1'));
});

test('stop request halts at next tool hook', async () => {
  const { hooks, base } = hookSetup();
  await hooks.handle({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  hooks.requestStop('s1');
  assert.deepEqual(await hooks.handle({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }), { continue: false, stopReason: STOP_REASON });
  assert.deepEqual(await hooks.handle({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }), {});
});

test('API: auth, lockout, state, stream, permission round trip over HTTP', async () => {
  const { root } = projectsDir();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cwh-'));
  const relay = await startRelay(
    { token: 't'.repeat(43), hookSecret: 'abc123', apiPort: 0, hookPort: 0, holdSeconds: 5, idleAwaySeconds: 1, awayMode: 'away', projectsDir: root, ntfy: { enabled: false } },
    { log: () => {}, idle: async () => 0, now: () => Date.parse('2026-11-12T10:00:20Z') },
  );
  try {
    const api = `http://127.0.0.1:${relay.api.address().port}`;
    const hookBase = `http://127.0.0.1:${relay.hook.address().port}/hook`;
    const hookUrl = `${hookBase}/abc123`;
    const J = { 'content-type': 'application/json' };
    assert.equal((await fetch(hookBase, { method: 'POST', headers: J, body: '{}' })).status, 404);
    assert.equal((await fetch(hookUrl, { method: 'POST', body: '{}' })).status, 404); // text/plain from a browser
    assert.equal((await fetch(hookUrl, { method: 'POST', headers: { ...J, origin: 'https://evil.example' }, body: '{}' })).status, 404);
    const H = { authorization: 'Bearer ' + 't'.repeat(43), 'content-type': 'application/json' };

    assert.equal((await fetch(`${api}/api/state`)).status, 401);
    const st = await (await fetch(`${api}/api/state`, { headers: H })).json();
    assert.equal(st.sessions[0].title, 'Login fix');
    assert.equal(st.away.effective, true);

    // SSE stream receives the permission.
    const ac = new AbortController();
    const stream = await fetch(`${api}/api/stream?session=s1`, { headers: H, signal: ac.signal });
    const reader = stream.body.getReader();
    let buf = '';
    const waitFor = async (needle) => {
      while (!buf.includes(needle)) buf += new TextDecoder().decode((await reader.read()).value);
    };
    await waitFor('event: hello');

    const hookResp = fetch(hookUrl, { method: 'POST', headers: J, body: JSON.stringify({ session_id: 's1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'make' }, cwd: '/Users/me/proj/app' }) }).then((r) => r.json());
    await waitFor('event: permission\n');
    const permId = JSON.parse(buf.split('event: permission\ndata: ')[1].split('\n')[0]).id;
    const r = await fetch(`${api}/api/permissions/${permId}`, { method: 'POST', headers: H, body: JSON.stringify({ behavior: 'allow' }) });
    assert.equal(r.status, 200);
    assert.equal((await hookResp).hookSpecificOutput.decision.behavior, 'allow');
    assert.equal((await fetch(`${api}/api/permissions/${permId}`, { method: 'POST', headers: H, body: '{"behavior":"allow"}' })).status, 410);
    ac.abort();

    const feed = await (await fetch(`${api}/api/sessions/s1?limit=2`, { headers: H })).json();
    assert.equal(feed.events.length, 2);
    assert.equal(feed.hasMore, true);

    // Lockout after repeated bad tokens.
    // Spoofed X-Forwarded-For prefixes don't dodge the per-client lockout.
    for (let i = 0; i < 10; i++) await fetch(`${api}/api/state`, { headers: { authorization: 'Bearer nope', 'x-forwarded-for': `10.0.0.${i}, 1.2.3.4` } });
    assert.equal((await fetch(`${api}/api/state`, { headers: { authorization: 'Bearer nope', 'x-forwarded-for': '1.2.3.4' } })).status, 429);
    assert.equal((await fetch(`${api}/api/state`, { headers: { ...H, 'x-forwarded-for': '1.2.3.4' } })).status, 200);
  } finally {
    await relay.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('addHooks/removeHooks keep the person’s own hooks and are idempotent', async () => {
  const { addHooks, removeHooks } = await import('../src/install.js');
  const mine = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }], PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'x' }] }] }, model: 'opus' };
  const once = addHooks(mine, 7861, 'ff');
  const twice = addHooks(once, 7861, 'ff');
  assert.deepEqual(once, twice);
  assert.equal(once.hooks.PreToolUse.length, 2);
  assert.equal(once.hooks.Stop[0].hooks[0].timeout, 600);
  assert.equal(once.allowedHttpHookUrls, undefined);
  assert.deepEqual(removeHooks(twice), mine);
  assert.deepEqual(addHooks({ allowedHttpHookUrls: [] }, 7861, 'ff').allowedHttpHookUrls, ['http://127.0.0.1:7861/hook/ff']);
});
