import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME = process.env.CLAUDEWATCH_HOME || path.join(os.homedir(), '.claudewatch');
export const CONFIG_PATH = path.join(HOME, 'config.json');

export const DEFAULTS = {
  apiPort: 7860,
  hookPort: 7861,
  holdSeconds: 540, // < Claude Code's 600 s hook timeout
  idleAwaySeconds: 180,
  awayMode: 'auto',
  projectsDir: path.join(os.homedir(), '.claude', 'projects'),
  publicUrl: '',
  ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '', detail: 'project' },
};

export function newSecrets() {
  return {
    token: crypto.randomBytes(32).toString('base64url'),
    ntfyTopic: 'cw-' + crypto.randomBytes(12).toString('hex'),
  };
}

export function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  return { ...DEFAULTS, ...file, ntfy: { ...DEFAULTS.ntfy, ...(file.ntfy || {}) } };
}

export function saveConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o600);
}
