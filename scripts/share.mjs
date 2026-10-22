#!/usr/bin/env node
// Serves this plugin on the local network so a teammate can install it with
// one command: curl -fsSL http://<your-ip>:47825/install.sh | sh
// Usage: node scripts/share.mjs [--port 47825] [--minutes 30]
import fs from 'node:fs';
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

/** The installer the teammate pipes into sh: install.sh, pointed at this machine's copy. */
function installScript(base) {
  const script = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  return script.replace('set -eu\n', `set -eu\nMULTIPLAYER_TARBALL="${base}/multiplayer.tar.gz"\n`);
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
