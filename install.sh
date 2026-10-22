#!/bin/sh
# Installs or updates Claude Multiplayer as a Claude Code marketplace plugin
# (multiplayer@claude-multiplayer). Every install method ends here, so each
# machine has exactly one copy and `claude plugin update` keeps it current.
# Usage: curl -fsSL https://raw.githubusercontent.com/NicholasDominici/claude-multiplayer/main/install.sh | sh
# Env:
#   MULTIPLAYER_SOURCE   marketplace source: GitHub owner/repo, git URL or local path
#   MULTIPLAYER_TARBALL  URL of a plugin tarball (scripts/share.mjs sets this for LAN installs)
set -eu

SOURCE="${MULTIPLAYER_SOURCE:-NicholasDominici/claude-multiplayer}"
MARKET="claude-multiplayer"
PLUGIN="multiplayer@$MARKET"
CONFIG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STATE="$HOME/.claude-multiplayer"

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code was not found. Install it from https://claude.com/claude-code, then run this again." >&2
  exit 1
fi

# Older versions installed into the skills folder. Two copies conflict, so move it out.
OLD="$CONFIG/skills/multiplayer"
if [ -e "$OLD" ] || [ -L "$OLD" ]; then
  BACKUP="$STATE/backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP"
  mv "$OLD" "$BACKUP/"
  echo "Moved the old copy in $OLD to $BACKUP"
fi

if [ -n "${MULTIPLAYER_TARBALL:-}" ]; then
  # LAN install: unpack the teammate's copy and use it as a local marketplace.
  LOCAL="$STATE/marketplace"
  TMP="$(mktemp -d)"
  echo "Downloading Claude Multiplayer from $MULTIPLAYER_TARBALL"
  curl -fsSL "$MULTIPLAYER_TARBALL" | tar -xzf - -C "$TMP"
  DIR="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [ ! -f "$DIR/.claude-plugin/marketplace.json" ]; then
    echo "Download failed: no plugin in the archive." >&2
    exit 1
  fi
  rm -rf "$LOCAL"
  mkdir -p "$STATE"
  mv "$DIR" "$LOCAL"
  rmdir "$TMP" 2>/dev/null || true
  SOURCE="$LOCAL"
fi

if claude plugin marketplace list 2>/dev/null | grep -q "$MARKET"; then
  claude plugin marketplace update "$MARKET"
else
  claude plugin marketplace add "$SOURCE"
fi

if claude plugin list 2>/dev/null | grep -q "$PLUGIN"; then
  claude plugin update "$PLUGIN"
else
  claude plugin install "$PLUGIN"
fi

# bin/node.sh also checks nvm, fnm, volta, asdf and mise; this only catches the common case.
if ! command -v node >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/node ] && [ ! -x /usr/local/bin/node ]; then
  echo "Warning: Node.js 18 or newer was not found. Install it from https://nodejs.org" >&2
fi

echo ""
echo "Claude Multiplayer is installed."
echo "Next: start a new Claude Code session (or run /reload-plugins), then run /multiplayer:multiplayer."
echo "Update later with: claude plugin update $PLUGIN"
