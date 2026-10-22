#!/bin/sh
# Codex hook entry point (see codex-hooks.json). Codex runs it on PostToolUse,
# Stop and UserPromptSubmit with the hook input on stdin. It finds this
# session's multiplayer server through the control socket named after the
# Codex process (an ancestor of this script) and prints the hook output the
# server returns. Outside a multiplayer session it exits at once with no output.
#
# Keep codex-hooks.json byte-for-byte stable across releases: Codex asks the
# user to trust each hook definition again whenever it changes.

dir="${MULTIPLAYER_STATE_DIR:-$HOME/.claude-multiplayer}/ctl"
[ -d "$dir" ] || exit 0
root="$(cd "$(dirname "$0")/.." && pwd)"

pid=$PPID
i=0
while [ "$i" -lt 8 ] && [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
  if [ -S "$dir/$pid.sock" ]; then
    exec sh "$root/bin/node.sh" "$root/server/hook.mjs" "$1" "$dir/$pid.sock"
  fi
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  i=$((i + 1))
done
exit 0
