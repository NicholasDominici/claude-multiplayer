# Claude Multiplayer

Pair two coding agent sessions on the same local network: Claude Code with Claude Code, Codex with Codex, or Claude Code with Codex. Each person keeps their own agent, and the two agents work as a team:

- **Find each other:** both people start multiplayer (`/multiplayer:multiplayer` in Claude Code, `$multiplayer` in Codex). The sessions find each other on the LAN with no setup.
- **Confirm the pair:** each screen shows the same 6-digit code. Each user confirms it, and only then does the link open.
- **Share a folder:** `~/claude-multiplayer/<pair-name>/` syncs live in both directions, and includes a `NOTES.md` coordination board.
- **Steer each other:** `multiplayer_message` sends a short note to the other agent. A `steer` arrives between the agent's tool calls, and an `fyi` waits until its turn ends. Codex needs its multiplayer hooks trusted once for this (see Install); until then it reads messages when it calls a multiplayer tool. The server limits how often an agent can send, so the two agents talk like two coworkers and do not interrupt each other all day.

## Install

Requirements: macOS or Linux, Node.js 18 or newer, and Claude Code 2.1.224 or newer, Codex CLI 0.160 or newer, or both.

Run this in a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/NicholasDominici/claude-multiplayer/main/install.sh | sh
```

The installer finds Claude Code and Codex on this machine and installs `multiplayer@claude-multiplayer` into each one from this repo's plugin marketplace. Then start a new session. Run the installer again to update.

**Codex, once:** start Codex, open `/hooks`, and trust the three multiplayer hooks. They let teammate messages reach Codex in the middle of a turn. Without them, Codex still works with multiplayer, but sees messages only when it calls a multiplayer tool. The hooks do nothing outside a multiplayer session.

If you prefer, run the steps yourself.

Claude Code:

```bash
claude plugin marketplace add https://github.com/NicholasDominici/claude-multiplayer.git && claude plugin install multiplayer@claude-multiplayer
```

Codex:

```bash
codex plugin marketplace add https://github.com/NicholasDominici/claude-multiplayer.git && codex plugin add multiplayer@claude-multiplayer
```

Both of you need compatible versions. If one side is too old, multiplayer says who must update.

Earlier versions installed into `~/.claude/skills/multiplayer`. The installer moves that copy to `~/.claude-multiplayer/backups/`, because two copies of the plugin conflict.

**Over the local network, without GitHub:** on a machine that has this repo, run `node scripts/share.mjs`. It prints a `curl` command for the teammate. That command runs the same installer, with this machine's copy as the marketplace.

## Use

1. You start multiplayer, optionally followed by what you want to build: `/multiplayer:multiplayer build a CLI for our API` in Claude Code, or `$multiplayer build a CLI for our API` in Codex.
2. Your teammate starts multiplayer in their agent.
3. Each agent shows the other session's name, agent and a code. Check that both screens show the same code, then confirm.
4. The agents split the work, claim files in `NOTES.md`, and message each other when it matters. If you did not say what to build in step 1, your agent asks.

Arguments are optional, in any order:

- Free text is the goal.
- `name=Nick` sets the name your teammate sees (default: your git first name).
- `dir=~/code/hackathon` sets the shared folder.

## How it works

| Part | How |
|------|-----|
| Discovery | UDP beacons every 2 s to multicast `239.255.77.77:47823` and each subnet's broadcast address. Sessions on the same machine also find each other through `~/.claude-multiplayer/beacons/`. |
| Pairing | Each session makes a new X25519 key pair. The code is an HMAC of the shared secret, so a man-in-the-middle makes the two screens show different codes. |
| Link | TCP on port 47824 (or a free port). Every frame after the hello is AES-256-GCM. The link reconnects on its own for 10 minutes if Wi-Fi drops. |
| Agents | Each session tells its teammate which agent it runs (taken from the MCP client name) and how it takes messages. Claude Code uses push delivery. Agents without an inbox socket use pull delivery: messages wait in the server and are added to the end of the next multiplayer tool result, and `multiplayer_inbox` checks or waits for them. If a push fails, the message is queued the same way instead of being lost. |
| Codex push | Codex runs the plugin's hooks (`codex-hooks.json`, `bin/codex-hook.sh`). Each hook finds this session's server through a control socket named after the Codex process, in `~/.claude-multiplayer/ctl/`. `PostToolUse` hands over steers as added context after each tool call, `Stop` continues the turn with any fyi, and `UserPromptSubmit` hands over what arrived while Codex was idle. The first hook call switches the session to push and tells the teammate. Keep `codex-hooks.json` unchanged across releases: Codex asks users to trust a hook again whenever its definition changes. |
| Steering | Claude Code binds a per-session inbox socket (`CLAUDE_CODE_MESSAGING_SOCKET`) for cross-session messages. The MCP server is a child process of the session, so it posts the teammate's message there as the session's own: `priority: "next"` for steer, `"later"` for fyi. |
| Shared folder | Scans once a second and sends changed files whole (8 MB max per file). The newer write wins. Deleted files and conflict losers move to `.multiplayer/trash/`, so sync never unlinks anything. `.git` and `node_modules` do not sync. The peer can write only inside the folder. |
| Pacing | One steer per 90 s, one fyi per 20 s, 20 messages per hour, 1500 characters. A reply to a message that just arrived is always allowed. |

Files:

- `skills/multiplayer/SKILL.md`: the multiplayer skill, shared by Claude Code and Codex. It holds the pairing steps and the teammate etiquette.
- `.claude-plugin/`: the Claude Code plugin and marketplace manifests. The MCP server is declared in `plugin.json`.
- `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`, `codex-mcp.json`: the Codex plugin, marketplace and MCP server. The server file is not named `.mcp.json`, because Claude Code would load that file too and start the server twice.
- `server/mcp.mjs`: the MCP server and its tool descriptions.
- `server/multiplayer.mjs`: discovery, pairing, the link, messages and notices.
- `server/inbox.mjs`: push delivery into Claude Code.
- `server/sync.mjs`: the folder mirror.
- `server/crypto.mjs`: keys, codes and encryption.
- `install.sh`: the installer for Claude Code and Codex (marketplace add, install or update, and migration from the old skills-folder copy).
- `scripts/share.mjs`: serves the installer and this copy over the LAN.
- `test/e2e.mjs`, `test/link.mjs`, `test/discovery.mjs`, `test/pull.mjs`: tests that run real servers on one machine.
- `test/hooks.mjs`: the Codex hook test.
- `test/codex-live.mjs`: the live Codex test.
- `codex-hooks.json`, `bin/codex-hook.sh`, `server/hook.mjs`: the Codex hooks for push delivery.

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

```bash
node test/hooks.mjs
```

`e2e.mjs` pairs two real servers with fake inbox sockets and checks pairing, messages, pacing and folder sync. `--udp-only` forces LAN discovery. `link.mjs` checks decline, the delayed accept notice and reconnect. `discovery.mjs` checks the notice when a teammate shows up and the message when versions do not match. `pull.mjs` pairs a push session with a pull session and checks queued messages, `multiplayer_inbox` and the fallback when a push fails. `hooks.mjs` runs the Codex hook script against a real server and checks what each hook hands over.

Before a release, also run the live Codex test. It pairs a real `codex exec` session with a scripted Claude Code side and has Codex do a small task over the link. It uses your Codex login and a little Codex usage. Codex runs in a throwaway `CODEX_HOME` with the plugin installed from this repo, and the copy of your login is deleted when the test ends. Add `--keep` to keep the transcript and shared folders. Add `--installed` to use your own Codex setup instead: once you have trusted the multiplayer hooks in `/hooks`, it checks that a steer interrupts Codex in the middle of a slow task.

```bash
node test/codex-live.mjs
```

## Troubleshooting

- **No session found (macOS):** open System Settings > Privacy & Security > Local Network, and turn it on for the app that runs your agent (Claude, Codex, Terminal, iTerm or VS Code). If the macOS firewall asks about `node`, allow incoming connections.
- **Codex is slow to see messages:** open `/hooks` in Codex and trust the multiplayer hooks. Without them, Codex reads teammate messages only when it calls a multiplayer tool. With them, a message that arrives while Codex sits idle still waits for your next prompt.
- **A message arrives late in Claude Code:** an `fyi` that arrives while Claude is busy waits until its turn ends, so it can show up after newer messages that Claude read through `multiplayer_inbox`.
- **Guest or office Wi-Fi:** many guest networks block traffic between devices. Use a phone hotspot or a home network, or try `multiplayer_join` with `address` set to the teammate's `ip:port`. The teammate's search result shows that address.
- **Messages do not arrive:** run `/status` in Claude Code and check the `Peer address` row. If `crossSessionInbound` is `refuse` in the settings, the session drops every cross-session message.
- **Logs:** `~/.claude-multiplayer/logs/`.

The plugin uses the network only after `/multiplayer:multiplayer`. Every session that has the plugin enabled starts the small MCP server, and that server stays idle until then.
