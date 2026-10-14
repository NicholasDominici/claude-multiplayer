#!/usr/bin/env node
// Serves this plugin on the local network so a teammate can install it with
// one command: curl -fsSL http://<your-ip>:47825/install.sh | sh
// Usage: node scripts/share.mjs [--port 47825] [--minutes 30]
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const port = arg('--port', 47825);
const minutes = arg('--minutes', 30);

const ips = Object.values(os.networkInterfaces())
  .flat()
  .filter((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal)
  .map((a) => a.address);

/** The installer script the teammate pipes into sh. */
function installScript(base) {
  return `#!/bin/sh
# Installs the Claude Multiplayer plugin into ~/.claude/skills/multiplayer.
set -eu
SRC="${base}/multiplayer.tar.gz"
DEST="$HOME/.claude/skills/multiplayer"
TMP="$(mktemp -d)"
echo "Downloading Claude Multiplayer from $SRC"
curl -fsSL "$SRC" | tar -xzf - -C "$TMP"
DIR="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [ ! -f "$DIR/.claude-plugin/plugin.json" ]; then
  echo "Download failed: no plugin in the archive." >&2
  exit 1
fi
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  # Keep backups outside ~/.claude/skills, or Claude Code loads them as a second plugin.
  BACKUP="$HOME/.claude-multiplayer/backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP"
  mv "$DEST" "$BACKUP/"
  echo "Moved the old copy to $BACKUP"
fi
mkdir -p "$HOME/.claude/skills"
mv "$DIR" "$DEST"
rmdir "$TMP" 2>/dev/null || true
chmod +x "$DEST/bin/node.sh" 2>/dev/null || true
if ! sh "$DEST/bin/node.sh" -e 0 2>/dev/null; then
  echo "Warning: Node.js 18 or newer was not found. Install it from https://nodejs.org" >&2
fi
echo ""
echo "Installed Claude Multiplayer in $DEST"
echo "Next: in Claude Code, run /reload-plugins (or start a new session), then run /multiplayer"
`;
}

const server = http.createServer((req, res) => {
  const hostHeader = /^[A-Za-z0-9.:[\]-]+$/.test(req.headers.host || '') ? req.headers.host : `${ips[0] || 'localhost'}:${port}`;
  const from = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (req.url === '/install.sh') {
    console.log(`${new Date().toLocaleTimeString()} ${from} fetched install.sh`);
    res.writeHead(200, { 'content-type': 'text/x-shellscript; charset=utf-8' });
    res.end(installScript(`http://${hostHeader}`));
    return;
  }
  if (req.url === '/multiplayer.tar.gz') {
    console.log(`${new Date().toLocaleTimeString()} ${from} downloaded the plugin`);
    res.writeHead(200, { 'content-type': 'application/gzip' });
    const tar = spawn('tar', [
      '-czf', '-',
      '--exclude', '.git', '--exclude', 'node_modules', '--exclude', '.DS_Store',
      '-C', path.dirname(root), path.basename(root),
    ], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    tar.stdout.pipe(res);
    tar.on('error', () => res.destroy());
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end(`Claude Multiplayer. Install with:\n  curl -fsSL http://${hostHeader}/install.sh | sh\n`);
});

server.on('error', (err) => {
  console.error(`share: ${err.message}`);
  process.exit(1);
});
server.listen(port, '0.0.0.0', () => {
  console.log('Claude Multiplayer share server is running.');
  console.log('Your teammate runs ONE of these in their terminal:');
  for (const ip of ips) console.log(`  curl -fsSL http://${ip}:${port}/install.sh | sh`);
  console.log(`It stops after ${minutes} minutes. Press Ctrl+C to stop it now.`);
  setTimeout(() => {
    console.log('share: time is up, stopping.');
    process.exit(0);
  }, minutes * 60_000).unref();
});
