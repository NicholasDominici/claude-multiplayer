#!/bin/sh
# Finds a Node.js 18+ binary and execs it with the given arguments.
# GUI-launched Claude Code sessions often have a short PATH, so common install
# locations are checked too. `exec` keeps the server a direct child of Claude
# Code, which the native inbox socket uses to trust the server's messages.

for candidate in \
  "$(command -v node 2>/dev/null)" \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /usr/bin/node \
  "$HOME/.local/bin/node" \
  "$HOME/.volta/bin/node" \
  "$HOME/.asdf/shims/node" \
  "$HOME/.local/share/mise/shims/node" \
  $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null) \
  $(ls -d "$HOME"/.fnm/node-versions/v*/installation/bin/node 2>/dev/null)
do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  major=$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || continue
  if [ "$major" -ge 18 ] 2>/dev/null; then
    exec "$candidate" "$@"
  fi
done

echo "multiplayer: Node.js 18 or newer is required. Install it from https://nodejs.org and restart Claude Code." >&2
exit 1
