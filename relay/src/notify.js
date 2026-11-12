// Short alerts through ntfy (https://ntfy.sh or a self-hosted server). Never carries code or commands.

export function makeNotifier(cfg, log = () => {}) {
  if (!cfg?.enabled || !cfg.topic) return () => {};
  const url = `${(cfg.server || 'https://ntfy.sh').replace(/\/$/, '')}/${cfg.topic}`;
  return ({ title, body, priority = 'default', tags = '' }) => {
    const headers = { Title: ascii(title), Priority: priority };
    if (tags) headers.Tags = tags;
    if (cfg.click) headers.Click = cfg.click;
    const text = cfg.detail === 'minimal' ? 'Open ClaudeWatch' : body;
    fetch(url, { method: 'POST', body: text, headers, signal: AbortSignal.timeout(5000) }).catch((e) => log(`ntfy: ${e.message}`));
  };
}

// HTTP header values must be ASCII; ntfy accepts UTF-8 titles via the body only.
function ascii(s) {
  return String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 120);
}
