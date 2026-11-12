// Pure helpers for adding/removing ClaudeWatch's hooks in ~/.claude/settings.json.

export const HOOK_EVENTS = {
  SessionStart: { timeout: 5 },
  UserPromptSubmit: { timeout: 5 },
  PreToolUse: { timeout: 5, matcher: '*' },
  PostToolUse: { timeout: 5, matcher: '*' },
  PermissionRequest: { timeout: 600, matcher: '*' },
  Notification: { timeout: 5 },
  Stop: { timeout: 600 },
  SessionEnd: { timeout: 2 },
};

export function hookUrl(port) {
  return `http://127.0.0.1:${port}/hook`;
}

const isOurs = (h) => h?.type === 'http' && typeof h.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/hook$/.test(h.url);

/** Returns a new settings object with ClaudeWatch hooks removed. */
export function removeHooks(settings) {
  const out = structuredClone(settings || {});
  if (!out.hooks) return out;
  for (const [ev, groups] of Object.entries(out.hooks)) {
    const kept = (groups || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) out.hooks[ev] = kept;
    else delete out.hooks[ev];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  if (Array.isArray(out.allowedHttpHookUrls)) {
    out.allowedHttpHookUrls = out.allowedHttpHookUrls.filter((u) => !/^http:\/\/127\.0\.0\.1:\d+\/hook$/.test(u));
  }
  return out;
}

/** Returns a new settings object with ClaudeWatch hooks added (idempotent; keeps the person's own hooks). */
export function addHooks(settings, port) {
  const out = removeHooks(settings);
  out.hooks ||= {};
  const url = hookUrl(port);
  for (const [ev, { timeout, matcher }] of Object.entries(HOOK_EVENTS)) {
    const group = { hooks: [{ type: 'http', url, timeout }] };
    if (matcher) group.matcher = matcher;
    out.hooks[ev] = [...(out.hooks[ev] || []), group];
  }
  // Only touch the allowlist if the person already uses one.
  if (Array.isArray(out.allowedHttpHookUrls) && !out.allowedHttpHookUrls.includes(url)) out.allowedHttpHookUrls.push(url);
  return out;
}

export function pairLink(publicUrl, token) {
  return `claudewatch://pair?u=${encodeURIComponent(publicUrl)}&t=${encodeURIComponent(token)}`;
}

export function launchdPlist({ node, script, logFile, label = 'com.claudewatch.relay' }) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(node)}</string><string>${esc(script)}</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(logFile)}</string>
</dict>
</plist>
`;
}
