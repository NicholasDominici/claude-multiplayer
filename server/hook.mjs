// Asks this session's multiplayer server for queued teammate messages on
// behalf of one Codex hook, and prints the hook output it returns.
// Usage (from bin/codex-hook.sh): node hook.mjs <event> <control socket>
// Any failure prints nothing and exits 0, so a hook never blocks Codex.
import net from 'node:net';

const [event, sockPath] = process.argv.slice(2);
process.stdin.resume();
process.stdin.on('data', () => {}); // the hook input is not needed; drain it so Codex does not block

const sock = net.connect(sockPath);
const timer = setTimeout(() => {
  sock.destroy();
  process.exit(0);
}, 2000);
let buf = '';
sock.on('connect', () => sock.write(JSON.stringify({ event }) + '\n'));
sock.on('data', (d) => {
  buf += d;
});
sock.on('end', () => {
  clearTimeout(timer);
  try {
    const { output } = JSON.parse(buf);
    if (output) process.stdout.write(output + '\n');
  } catch {}
  process.exit(0);
});
sock.on('error', () => process.exit(0));
