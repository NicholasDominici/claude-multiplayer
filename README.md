# Claude Multiplayer

Pair two Claude Code sessions on the same local network. Each person keeps their own Claude, and the two Claudes work as a team:

- **Find each other:** both people run `/multiplayer:multiplayer`. The sessions find each other on the LAN with no setup.
- **Confirm the pair:** each screen shows the same 6-digit code. Each user confirms it, and only then does the link open.
- **Share a folder:** `~/claude-multiplayer/<pair-name>/` syncs live in both directions, and includes a `NOTES.md` coordination board.
- **Steer each other:** `multiplayer_message` puts a short note into the other Claude's running session. A `steer` arrives between that Claude's tool calls. An `fyi` waits until its turn ends. The server limits how often a Claude can send, so the two Claudes talk like two coworkers and do not interrupt each other all day.

## Install

Requirements: macOS or Linux, Claude Code 2.1.224 or newer, Node.js 18 or newer.

Run this in a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/NicholasDominici/claude-multiplayer/main/install.sh | sh
```

Then start a new Claude Code session, or run `/reload-plugins` in an open one.

The installer adds this repo as a plugin marketplace and installs `multiplayer@claude-multiplayer`. If you prefer, run the same two steps yourself in Claude Code:

```text
/plugin marketplace add NicholasDominici/claude-multiplayer
```

```text
/plugin install multiplayer@claude-multiplayer
```

Update:

```bash
claude plugin update multiplayer@claude-multiplayer
```

Both of you need compatible versions. If one side is too old, `/multiplayer:multiplayer` says who must update.

Earlier versions installed into `~/.claude/skills/multiplayer`. The installer moves that copy to `~/.claude-multiplayer/backups/`, because two copies of the plugin conflict.

**Over the local network, without GitHub:** on a machine that has this repo, run `node scripts/share.mjs`. It prints a `curl` command for the teammate. That command runs the same installer, with this machine's copy as the marketplace.

## Use

1. You run `/multiplayer:multiplayer`, optionally followed by what you want to build.
2. Your teammate runs `/multiplayer:multiplayer`.
3. Each Claude gets a notice with the other session's name and a code. Check that both screens show the same code, then choose **Codes match, pair**.
4. The Claudes split the work, claim files in `NOTES.md`, and message each other when it matters. If you did not say what to build in step 1, your Claude asks.

Arguments are optional, in any order:

- Free text is the goal: `/multiplayer:multiplayer build a CLI for our API`.
- `name=Nick` sets the name your teammate sees (default: your git first name).
- `dir=~/code/hackathon` sets the shared folder.

## How it works

| Part | How |
|------|-----|
| Discovery | UDP beacons every 2 s to multicast `239.255.77.77:47823` and each subnet's broadcast address. Sessions on the same machine also find each other through `~/.claude-multiplayer/beacons/`. |
| Pairing | Each session makes a new X25519 key pair. The code is an HMAC of the shared secret, so a man-in-the-middle makes the two screens show different codes. |
| Link | TCP on port 47824 (or a free port). Every frame after the hello is AES-256-GCM. The link reconnects on its own for 10 minutes if Wi-Fi drops. |
| Agents | Each session tells its teammate which agent it runs (taken from the MCP client name) and how it takes messages. Claude Code uses push delivery. Agents without an inbox socket, such as Codex, use pull delivery: messages wait in the server and are added to the end of the next multiplayer tool result, and `multiplayer_inbox` checks or waits for them. If a push fails, the message is queued the same way instead of being lost. |
| Steering | Claude Code binds a per-session inbox socket (`CLAUDE_CODE_MESSAGING_SOCKET`) for cross-session messages. The MCP server is a child process of the session, so it posts the teammate's message there as the session's own: `priority: "next"` for steer, `"later"` for fyi. |
| Shared folder | Scans once a second and sends changed files whole (8 MB max per file). The newer write wins. Deleted files and conflict losers move to `.multiplayer/trash/`, so sync never unlinks anything. `.git` and `node_modules` do not sync. The peer can write only inside the folder. |
| Pacing | One steer per 90 s, one fyi per 20 s, 20 messages per hour, 1500 characters. A reply to a message that just arrived is always allowed. |

Files:

- `SKILL.md`: the `/multiplayer:multiplayer` skill. It holds the pairing steps and the teammate etiquette.
- `server/mcp.mjs`: the MCP server and its tool descriptions.
- `server/multiplayer.mjs`: discovery, pairing, the link, messages and notices.
- `server/inbox.mjs`: push delivery into Claude Code.
- `server/sync.mjs`: the folder mirror.
- `server/crypto.mjs`: keys, codes and encryption.
- `install.sh`: the installer (marketplace add, install or update, and migration from the old skills-folder copy).
- `scripts/share.mjs`: serves the installer and this copy over the LAN.
- `test/e2e.mjs`, `test/link.mjs`, `test/discovery.mjs`, `test/pull.mjs`: tests that run real servers on one machine.

## Test

```bash
node test/e2e.mjs
```

```bash
node test/e2e.mjs --udp-only
```

```bash
node test/link.mjs
```

```bash
node test/discovery.mjs
```

```bash
node test/pull.mjs
```

`e2e.mjs` pairs two real servers with fake inbox sockets and checks pairing, messages, pacing and folder sync. `--udp-only` forces LAN discovery. `link.mjs` checks decline, the delayed accept notice and reconnect. `discovery.mjs` checks the notice when a teammate shows up and the message when versions do not match. `pull.mjs` pairs a push session with a pull session and checks queued messages, `multiplayer_inbox` and the fallback when a push fails.

## Troubleshooting

- **No session found (macOS):** open System Settings > Privacy & Security > Local Network, and turn it on for the app that runs Claude Code (Claude, Terminal, iTerm or VS Code). If the macOS firewall asks about `node`, allow incoming connections.
- **Guest or office Wi-Fi:** many guest networks block traffic between devices. Use a phone hotspot or a home network, or try `multiplayer_join` with `address` set to the teammate's `ip:port`. The teammate's search result shows that address.
- **Messages do not arrive:** run `/status` in Claude Code and check the `Peer address` row. If `crossSessionInbound` is `refuse` in the settings, the session drops every cross-session message.
- **Logs:** `~/.claude-multiplayer/logs/`.

The plugin uses the network only after `/multiplayer:multiplayer`. Every session that has the plugin enabled starts the small MCP server, and that server stays idle until then.
