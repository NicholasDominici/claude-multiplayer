#!/bin/sh
# Installs or updates Claude Multiplayer in ~/.claude/skills/multiplayer.
# Claude Code loads every folder there that has .claude-plugin/plugin.json as
# a plugin, and the root SKILL.md becomes the /multiplayer command.
# Usage: curl -fsSL https://raw.githubusercontent.com/NicholasDominici/claude-multiplayer/main/install.sh | sh
set -eu

REPO="https://github.com/NicholasDominici/claude-multiplayer"
DEST="$HOME/.claude/skills/multiplayer"

if [ -d "$DEST/.git" ]; then
  echo "Updating Claude Multiplayer in $DEST"
  git -C "$DEST" pull --ff-only
else
  if [ -e "$DEST" ] || [ -L "$DEST" ]; then
    # Keep backups outside ~/.claude/skills, or Claude Code loads them as a second plugin.
    BACKUP="$HOME/.claude-multiplayer/backups/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$BACKUP"
    mv "$DEST" "$BACKUP/"
    echo "Moved the old copy to $BACKUP"
  fi
  mkdir -p "$HOME/.claude/skills"
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 "$REPO.git" "$DEST"
  else
    TMP="$(mktemp -d)"
    curl -fsSL "$REPO/archive/refs/heads/main.tar.gz" | tar -xzf - -C "$TMP"
    mv "$TMP/claude-multiplayer-main" "$DEST"
    rmdir "$TMP" 2>/dev/null || true
  fi
fi

chmod +x "$DEST/bin/node.sh" 2>/dev/null || true
if ! sh "$DEST/bin/node.sh" -e 0 2>/dev/null; then
  echo "Warning: Node.js 18 or newer was not found. Install it from https://nodejs.org" >&2
fi
echo ""
echo "Claude Multiplayer is installed in $DEST"
echo "Next: in Claude Code, run /reload-plugins (or start a new session), then run /multiplayer"
