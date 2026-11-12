# ClaudeWatch

Follow and steer every Claude Code session (CLI and desktop app, all projects) from your Apple Watch, from anywhere.

- Live feed per session: your prompts, Claude's replies (Markdown), each tool call with its command/diff/output, subagents grouped under their call.
- Approve or deny permission prompts (with an optional note), reply to Claude (dictation or quick replies), stop a session.
- Complication and Smart Stack widget: how many sessions need you, what's running.
- Alerts through the ntfy iPhone app, mirrored to the watch.

```
Claude Code ──writes──> ~/.claude/projects/**/*.jsonl ──tail──┐
     └── http hooks ──> 127.0.0.1:7861/hook/<secret> ─────────> relay (Node, launchd)
                                                                  │ 127.0.0.1:7860 /api (bearer token)
                                     Tailscale Funnel (HTTPS) ────┘
Apple Watch app ⇄ HTTPS + SSE        iPhone app: confirms the pairing link, syncs it to the watch
```

## How control works

**Away mode** decides whether Claude waits for your watch:

| Mode | Behaviour |
|---|---|
| Auto (default) | Away after 3 minutes without keyboard/mouse input on the Mac |
| Away | Always wait for the watch |
| At desk | Never wait; the watch only shows what happens |

- **Permission prompts.** At the desk, Claude's normal dialog appears and the watch says "Answer at your Mac". When away, Claude waits up to 9 minutes for Allow / Always allow / Deny / Deny with note. With no answer in that time, the normal dialog appears on the Mac.
- **Reply.** A reply is delivered the next time Claude finishes a turn, and Claude continues with it. When away, a finished session keeps listening for up to 9 minutes, so a reply sent after it finished still lands.
- **Stop.** Claude stops before its next tool call.

The relay never breaks a session. If it is down, Claude Code carries on as normal.

## Security

The API can approve shell commands, so treat the pairing link like a password.

- A 256-bit token guards the public API. Comparison is constant-time. Failed attempts lock out after 10 per client or 50 in total per 10 minutes.
- The hook port listens on loopback only, is never funneled, and requires a random secret path, a JSON body and no browser `Origin`.
- `~/.claudewatch/config.json` and `~/.claude/settings.json` are written with mode 0600.
- The watch always shows the full command or path before Allow.
- The iPhone app asks before it accepts a pairing link and shows the relay host. The watch app does not accept pairing links from other apps.
- ntfy alerts contain only the project name and the tool name, never commands or code.

## Setup

Needs: macOS with Node 20+, Xcode 16+, [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`), Tailscale, an iPhone with a paired Apple Watch.

### 1. Tailscale Funnel (once)

1. Open Tailscale.app and log in.
2. In the Tailscale admin console, enable HTTPS certificates and Funnel for your tailnet (Access controls → add the `funnel` node attribute). `tailscale funnel` prints a link to the exact page if this is missing.

### 2. Relay

```bash
cd relay
node --test test/
```

```bash
node bin/claudewatch.js install
```

`install` does all of this:
- creates `~/.claudewatch/config.json` with the token, hook secret and ntfy topic;
- backs up `~/.claude/settings.json` to `settings.json.claudewatch-backup`, then adds its hooks (your existing hooks stay);
- starts the relay as the launchd agent `com.claudewatch.relay` (log: `~/.claudewatch/relay.log`);
- runs `tailscale funnel --bg 7860`;
- prints the ntfy topic and opens the pairing QR code in Preview.

Restart running Claude Code sessions so they load the new hooks.

Other commands: `status`, `pair` (show the QR again), `away auto|away|desk`, `funnel`, `uninstall` (removes hooks, launchd agent and Funnel).

### 3. Apps on your iPhone and watch (free Apple ID)

```bash
cd apple
xcodegen generate
open ClaudeWatch.xcodeproj
```

1. Xcode → Settings → Accounts: add your Apple ID.
2. For the targets `ClaudeWatch`, `ClaudeWatchWatch` and `ClaudeWatchWidgets`, under Signing & Capabilities pick your Personal Team. If the bundle ID is taken, change `com.tanushmalhotra` in `project.yml` and run `xcodegen generate` again.
3. On the iPhone and the watch, turn on Settings → Privacy & Security → Developer Mode.
4. Select the `ClaudeWatch` scheme and your iPhone, then Run. The watch app installs with it (or select the `ClaudeWatchWatch` scheme and the watch to install it directly).
5. On the iPhone: Settings → General → VPN & Device Management → trust your developer certificate.

A free Apple ID signs apps for 7 days. After that, connect the phone and press Run again.

### 4. Pair

1. On the Mac: `node relay/bin/claudewatch.js pair`.
2. Scan the QR code with the iPhone Camera app and tap the banner.
3. Confirm the host in ClaudeWatch. The iPhone sends the pairing to the watch.

No iPhone app? Copy the link and paste it in the watch app (Paste link).

### 5. Alerts

Install **ntfy** on the iPhone and subscribe to the topic that `install` printed (server `https://ntfy.sh`). Allow its notifications; iOS mirrors them to the watch. Alerts are sent only when you are away.

### 6. Complication

Long-press the watch face → Edit → Complications → Claude. Or add Claude to the Smart Stack.

## Development

```bash
cd relay && node --test test/
```

```bash
cd apple/ClaudeWatchKit && swift test
```

```bash
cd apple && xcodegen generate && xcodebuild -scheme ClaudeWatch -destination 'generic/platform=iOS Simulator' build
```

The relay tests write `fixtures/api/*.json` from real relay output; the Swift tests decode copies of them, so the two sides stay in sync. After changing the API, copy `fixtures/api/*.json` to `apple/ClaudeWatchKit/Tests/ClaudeWatchKitTests/Fixtures/`.

To run a throwaway relay: `CLAUDEWATCH_HOME=/tmp/cw node bin/claudewatch.js start`.
