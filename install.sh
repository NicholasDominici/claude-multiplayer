#!/bin/sh
# Installs or updates Multiplayer as a marketplace plugin
# (multiplayer@multiplayer) in every supported agent found on this
# machine: Claude Code and Codex. Every install method ends here, so each agent
# has exactly one copy and its own plugin update command keeps it current.
# Usage: curl -fsSL https://raw.githubusercontent.com/NicholasDominici/multiplayer/main/install.sh | sh
# Env:
#   MULTIPLAYER_SOURCE   marketplace source: git URL (HTTPS by default, so no GitHub SSH key is needed), owner/repo or local path
#   MULTIPLAYER_TARBALL  URL of a plugin tarball (scripts/share.mjs sets this for LAN installs)
set -eu

SOURCE="${MULTIPLAYER_SOURCE:-https://github.com/NicholasDominici/multiplayer.git}"
MARKET="multiplayer"
PLUGIN="multiplayer@$MARKET"
# Versions up to 0.4 used the marketplace name claude-multiplayer. Two copies conflict, so it is removed.
OLD_MARKET="claude-multiplayer"
OLD_PLUGIN="multiplayer@$OLD_MARKET"
CONFIG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
# The state folder keeps its old name; the server and the Codex hooks use it too.
STATE="$HOME/.claude-multiplayer"

HAVE_CLAUDE=""
HAVE_CODEX=""
command -v claude >/dev/null 2>&1 && HAVE_CLAUDE=1
command -v codex >/dev/null 2>&1 && HAVE_CODEX=1
if [ -z "$HAVE_CLAUDE" ] && [ -z "$HAVE_CODEX" ]; then
  echo "Neither Claude Code nor Codex was found. Install one of them, then run this again." >&2
  exit 1
fi

# Older versions installed into the Claude skills folder. Two copies conflict, so move it out.
OLD="$CONFIG/skills/multiplayer"
if [ -n "$HAVE_CLAUDE" ] && { [ -e "$OLD" ] || [ -L "$OLD" ]; }; then
  BACKUP="$STATE/backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP"
  mv "$OLD" "$BACKUP/"
  echo "Moved the old copy in $OLD to $BACKUP"
fi

if [ -n "${MULTIPLAYER_TARBALL:-}" ]; then
  # LAN install: unpack the teammate's copy and use it as a local marketplace.
  LOCAL="$STATE/marketplace"
  TMP="$(mktemp -d)"
  echo "Downloading Multiplayer from $MULTIPLAYER_TARBALL"
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

if [ -n "$HAVE_CLAUDE" ]; then
  echo "Installing into Claude Code"
  if claude plugin list 2>/dev/null | grep -q "$OLD_PLUGIN"; then
    claude plugin uninstall "$OLD_PLUGIN" && echo "Removed the old $OLD_PLUGIN"
  fi
  if claude plugin marketplace list --json 2>/dev/null | grep -q "\"name\": \"$OLD_MARKET\""; then
    claude plugin marketplace remove "$OLD_MARKET"
  fi
  if claude plugin marketplace list --json 2>/dev/null | grep -q "\"name\": \"$MARKET\""; then
    claude plugin marketplace update "$MARKET"
  else
    claude plugin marketplace add "$SOURCE"
  fi
  if claude plugin list 2>/dev/null | grep -q "$PLUGIN"; then
    claude plugin update "$PLUGIN"
  else
    claude plugin install "$PLUGIN"
  fi
fi

if [ -n "$HAVE_CODEX" ]; then
  echo "Installing into Codex"
  if codex plugin list 2>/dev/null | grep -q "^$OLD_PLUGIN "; then
    codex plugin remove "$OLD_PLUGIN" && echo "Removed the old $OLD_PLUGIN"
  fi
  if codex plugin marketplace list 2>/dev/null | grep -q "^$OLD_MARKET "; then
    codex plugin marketplace remove "$OLD_MARKET"
  fi
  if codex plugin marketplace list 2>/dev/null | grep -q "^$MARKET "; then
    # Refreshes Git sources; a local source is read in place.
    codex plugin marketplace upgrade "$MARKET" 2>/dev/null || true
  else
    codex plugin marketplace add "$SOURCE"
  fi
  codex plugin add "$PLUGIN"
fi

# bin/node.sh also checks nvm, fnm, volta, asdf and mise; this only catches the common case.
if ! command -v node >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/node ] && [ ! -x /usr/local/bin/node ]; then
  echo "Warning: Node.js 18 or newer was not found. Install it from https://nodejs.org" >&2
fi

echo ""
echo "Multiplayer is installed."
if [ -n "$HAVE_CLAUDE" ]; then
  echo "Claude Code: start a new session (or run /reload-plugins), then run /multiplayer:multiplayer."
fi
if [ -n "$HAVE_CODEX" ]; then
  echo "Codex: start a new session, then type \$multiplayer. Optional: trust the multiplayer hooks in /hooks so messages can interrupt Codex mid-turn."
fi
echo "Run this installer again to update."
