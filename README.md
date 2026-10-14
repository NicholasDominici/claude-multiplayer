# Claude Multiplayer

Pair two Claude Code sessions on the same local network. Each person keeps their own Claude, and the two Claudes work as a team:

- **Find each other:** both people run `/multiplayer`. The sessions find each other on the LAN with no setup.
- **Confirm the pair:** each screen shows the same 6-digit code. Each user confirms it, and only then does the link open.
- **Share a folder:** `~/claude-multiplayer/<pair-name>/` syncs live in both directions, and includes a `NOTES.md` coordination board.
- **Steer each other:** `multiplayer_message` puts a short note into the other Claude's running session. A `steer` arrives between that Claude's tool calls. An `fyi` waits until its turn ends. The server limits how often a Claude can send, so the two Claudes talk like two coworkers and do not interrupt each other all day.

## Install

Requirements: macOS or Linux, Claude Code 2.1.224 or newer, Node.js 18 or newer.

Run this in a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/NicholasDominici/claude-multiplayer/main/install.sh | sh
```

Then, in Claude Code, run `/reload-plugins` or start a new session. Run the same command again to update.

The installer clones this repo into `~/.claude/skills/multiplayer`. Claude Code loads every folder there that has a `.claude-plugin/plugin.json` as a plugin, and the root `SKILL.md` becomes the `/multiplayer` command.

**From the plugin marketplace (alternative):** in Claude Code, run these two commands. With this method the command is `/multiplayer:multiplayer`. Use only one install method, because two copies of the plugin conflict.

```text
/plugin marketplace add NicholasDominici/claude-multiplayer
```

```text
/plugin install multiplayer@claude-multiplayer
```

**Over the local network, without GitHub:** on a machine that has the plugin, run `node scripts/share.mjs`. It prints a `curl` command for the teammate.

## Use

1. You run `/multiplayer`.
2. Your teammate runs `/multiplayer`.
3. Each Claude shows the other session's name and a code. Check that both screens show the same code, then choose **Codes match, pair**.
4. Tell your Claude what the two of you will build. The Claudes split the work, claim files in `NOTES.md`, and message each other when it matters.

Optional arguments: `/multiplayer Nick ~/code/hackathon` sets your display name and the shared folder.

## How it works

| Part | How |
|------|-----|
| Discovery | UDP beacons every 2 s to multicast `239.255.77.77:47823` and each subnet's broadcast address. Sessions on the same machine also find each other through `~/.claude-multiplayer/beacons/`. |
| Pairing | Each session makes a new X25519 key pair. The code is an HMAC of the shared secret, so a man-in-the-middle makes the two screens show different codes. |
| Link | TCP on port 47824 (or a free port). Every frame after the hello is AES-256-GCM. The link reconnects on its own for 10 minutes if Wi-Fi drops. |
| Steering | Claude Code binds a per-session inbox socket (`CLAUDE_CODE_MESSAGING_SOCKET`) for cross-session messages. The MCP server is a child process of the session, so it posts the teammate's message there as the session's own: `priority: "next"` for steer, `"later"` for fyi. |
| Shared folder | Scans once a second and sends changed files whole (8 MB max per file). The newer write wins. Deleted files and conflict losers move to `.multiplayer/trash/`, so sync never unlinks anything. `.git` and `node_modules` do not sync. The peer can write only inside the folder. |
| Pacing | One steer per 90 s, one fyi per 20 s, 20 messages per hour, 1500 characters. A reply to a message that just arrived is always allowed. |

Files:

- `SKILL.md`: the `/multiplayer` skill. It holds the pairing steps and the teammate etiquette.
- `server/mcp.mjs`: the MCP server and its tool descriptions.
- `server/multiplayer.mjs`: discovery, pairing, the link, messages and notices.
- `server/inbox.mjs`: delivery into Claude Code.
- `server/sync.mjs`: the folder mirror.
- `server/crypto.mjs`: keys, codes and encryption.
- `scripts/share.mjs`: the LAN installer.
- `test/e2e.mjs`, `test/link.mjs`: tests that pair real servers on one machine.

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

`e2e.mjs` pairs two real servers with fake inbox sockets and checks pairing, messages, pacing and folder sync. `--udp-only` forces LAN discovery. `link.mjs` checks decline, the delayed accept notice and reconnect.

## Troubleshooting

- **No session found (macOS):** open System Settings > Privacy & Security > Local Network, and turn it on for the app that runs Claude Code (Claude, Terminal, iTerm or VS Code). If the macOS firewall asks about `node`, allow incoming connections.
- **Guest or office Wi-Fi:** many guest networks block traffic between devices. Use a phone hotspot or a home network, or try `multiplayer_join` with `address` set to the teammate's `ip:port`. The teammate's search result shows that address.
- **Messages do not arrive:** run `/status` in Claude Code and check the `Peer address` row. If `crossSessionInbound` is `refuse` in the settings, the session drops every cross-session message.
- **Logs:** `~/.claude-multiplayer/logs/`.

The plugin uses the network only after `/multiplayer`. Every session that has the plugin enabled starts the small MCP server, and that server stays idle until then.
