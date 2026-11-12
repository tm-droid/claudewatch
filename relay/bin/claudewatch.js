#!/usr/bin/env node
// ClaudeWatch relay CLI: start | install | uninstall | pair | status | away <auto|away|desk>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, newSecrets, HOME } from '../src/config.js';
import { addHooks, removeHooks, pairLink, launchdPlist } from '../src/install.js';

const SCRIPT = fileURLToPath(import.meta.url);
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const LABEL = 'com.claudewatch.relay';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(HOME, 'relay.log');
const TAILSCALE = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'].find((p) => fs.existsSync(p));
const uid = process.getuid();

const say = (...a) => console.log(...a);

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`Can't parse ${SETTINGS}: ${e.message}`);
  }
}

// settings.json now holds the hook secret, so it and its backup are kept owner-only.
function writeSettings(obj) {
  const backup = `${SETTINGS}.claudewatch-backup`;
  if (fs.existsSync(SETTINGS)) {
    fs.copyFileSync(SETTINGS, backup);
    fs.chmodSync(backup, 0o600);
  }
  const tmp = SETTINGS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, SETTINGS);
}

function tailscale(args, opts = {}) {
  if (!TAILSCALE) throw new Error('Tailscale CLI not found. Install Tailscale from https://tailscale.com/download/mac');
  return execFileSync(TAILSCALE, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, ...opts });
}

function funnelUrl() {
  const st = JSON.parse(tailscale(['status', '--json']));
  const dns = st.Self?.DNSName?.replace(/\.$/, '');
  if (!dns) throw new Error('Tailscale is not logged in.');
  return `https://${dns}`;
}

function setupFunnel(cfg) {
  try {
    tailscale(['funnel', '--bg', String(cfg.apiPort)]);
    cfg.publicUrl = funnelUrl();
    say(`✓ Tailscale Funnel: ${cfg.publicUrl} → 127.0.0.1:${cfg.apiPort}`);
  } catch (e) {
    say(`! Tailscale Funnel not set up: ${(e.stderr || e.message).toString().trim().split('\n')[0]}`);
    say('  Open Tailscale, log in, enable Funnel for this device (admin console), then run: claudewatch funnel');
  }
}

function showQR(text) {
  const png = path.join(HOME, 'pair.png');
  const swift = `
import CoreImage; import AppKit
let f = CIFilter(name: "CIQRCodeGenerator")!
f.setValue(CommandLine.arguments[1].data(using: .utf8), forKey: "inputMessage")
f.setValue("M", forKey: "inputCorrectionLevel")
let img = f.outputImage!.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
let rep = NSBitmapImageRep(ciImage: img)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
`;
  const src = path.join(HOME, 'qr.swift');
  fs.writeFileSync(src, swift);
  const r = spawnSync('/usr/bin/swift', [src, text, png], { encoding: 'utf8' });
  if (r.status === 0) {
    fs.chmodSync(png, 0o600);
    spawnSync('/usr/bin/open', ['-a', 'Preview', png]);
    say(`✓ Pairing QR opened in Preview (${png}). Scan it with the ClaudeWatch iPhone app.`);
  } else say('! Could not render the QR code; paste the link into the iPhone app instead.');
}

function launchd(action) {
  const target = `gui/${uid}`;
  if (action === 'load') {
    spawnSync('/bin/launchctl', ['bootout', `${target}/${LABEL}`]);
    const r = spawnSync('/bin/launchctl', ['bootstrap', target, PLIST], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr.trim()}`);
  } else spawnSync('/bin/launchctl', ['bootout', `${target}/${LABEL}`]);
}

async function api(cfg, method, p, body) {
  const r = await fetch(`http://127.0.0.1:${cfg.apiPort}/api${p}`, {
    method, headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(3000),
  });
  return r.json();
}

const commands = {
  async start() {
    const { startRelay } = await import('../src/server.js');
    const relay = await startRelay(loadConfig(), { log: (m) => console.log(new Date().toISOString(), m) });
    const shutdown = () => relay.close().then(() => process.exit(0));
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  },

  async install() {
    const cfg = loadConfig();
    const s = newSecrets();
    if (!cfg.token) {
      cfg.token = s.token;
      cfg.ntfy = { ...cfg.ntfy, enabled: true, topic: s.ntfyTopic };
    }
    cfg.hookSecret ||= s.hookSecret;
    saveConfig(cfg);
    say(`✓ Config: ${path.join(HOME, 'config.json')}`);

    writeSettings(addHooks(readSettings(), cfg.hookPort, cfg.hookSecret));
    say(`✓ Hooks added to ${SETTINGS} (backup: settings.json.claudewatch-backup)`);

    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.writeFileSync(PLIST, launchdPlist({ node: process.execPath, script: SCRIPT, logFile: LOG }));
    launchd('load');
    say(`✓ Relay running in the background (log: ${LOG})`);

    setupFunnel(cfg);
    saveConfig(cfg);
    say(`\nAlerts: install "ntfy" on your iPhone and subscribe to topic:\n  ${cfg.ntfy.topic}\n(server ${cfg.ntfy.server}; alerts carry the project and tool name only)\n`);
    if (cfg.publicUrl) await commands.pair();
  },

  async funnel() {
    const cfg = loadConfig();
    setupFunnel(cfg);
    saveConfig(cfg);
  },

  async pair() {
    const cfg = loadConfig();
    if (!cfg.publicUrl) return say('No public URL yet. Run: claudewatch funnel');
    const link = pairLink(cfg.publicUrl, cfg.token);
    say(`Pairing link (keep it private — it lets the holder approve commands on this Mac):\n  ${link}`);
    showQR(link);
  },

  async uninstall() {
    launchd('unload');
    if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST);
    writeSettings(removeHooks(readSettings()));
    const cfg = loadConfig();
    try {
      tailscale(['funnel', String(cfg.apiPort), 'off']);
    } catch {}
    say(`✓ Removed hooks, launchd agent${TAILSCALE ? ' and Funnel' : ''}. Config left in ${HOME} (delete it to forget the token).`);
  },

  async status() {
    const cfg = loadConfig();
    try {
      const st = await api(cfg, 'GET', '/state');
      say(`Relay: up · away=${st.away.mode}${st.away.effective ? ' (away now)' : ''} · ${st.sessions.length} sessions · ${st.permissions.length} pending permissions`);
      for (const s of st.sessions.slice(0, 8)) say(`  ${s.status.padEnd(9)} ${s.project.padEnd(18)} ${s.title}`);
    } catch {
      say(`Relay: not reachable on 127.0.0.1:${cfg.apiPort}`);
    }
    say(`Public URL: ${cfg.publicUrl || '(none)'}`);
  },

  async away(mode) {
    const cfg = loadConfig();
    const r = await api(cfg, 'POST', '/away', { mode });
    say(r.error || `away mode: ${r.away.mode}${r.away.effective ? ' (away now)' : ''}`);
  },
};

const [cmd = 'status', ...args] = process.argv.slice(2);
if (!commands[cmd]) {
  say('usage: claudewatch start | install | uninstall | funnel | pair | status | away <auto|away|desk>');
  process.exit(1);
}
commands[cmd](...args).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
