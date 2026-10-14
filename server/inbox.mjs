// Delivers text into this Claude Code session through its native inbox socket.
// Claude Code (v2.1.224+) binds one Unix socket per session for cross-session
// messages. A "next" message reaches Claude between tool calls of the running
// turn (a steer); a "later" message waits until the turn ends. Either one
// starts a new turn when the session is idle. This server is a child process
// of the session, so Claude Code treats its messages as the session's own.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** Returns the session's inbox socket path, or null when the session has none. */
export function findInboxSocket(env = process.env) {
  if (env.CLAUDE_CODE_MESSAGING_SOCKET) return env.CLAUDE_CODE_MESSAGING_SOCKET;
  const pid = env.CLAUDE_PID || String(process.ppid);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const dirs = ['/tmp/cc-socks', uid !== undefined ? `/tmp/cc-socks-${uid}` : null];
  for (const dir of dirs.filter(Boolean)) {
    const candidate = path.join(dir, `${pid}.sock`);
    try {
      if (fs.statSync(candidate).isSocket()) return candidate;
    } catch {}
  }
  return null;
}

/**
 * Posts one message to the inbox socket.
 * Resolves { ok: true } once the line is written, or { ok: false, error }.
 */
export function deliverToClaude(socketPath, content, { from, priority = 'next', msgId } = {}) {
  return new Promise((resolve) => {
    if (!socketPath) {
      resolve({ ok: false, error: 'this Claude Code session has no inbox socket (needs Claude Code 2.1.224 or newer)' });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const sock = net.connect(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      finish({ ok: false, error: 'inbox socket timed out' });
    }, 5000);
    sock.on('error', (err) => finish({ ok: false, error: `inbox socket: ${err.code || err.message}` }));
    sock.on('connect', () => {
      const lines = [];
      if (process.env.CLAUDE_CODE_MESSAGING_TOKEN) {
        lines.push(JSON.stringify({ type: 'auth', token: process.env.CLAUDE_CODE_MESSAGING_TOKEN }));
      }
      lines.push(JSON.stringify({
        type: 'user',
        message: { role: 'user', content },
        from: from || 'multiplayer',
        from_plugin: 'multiplayer',
        priority,
        ...(msgId ? { msg_id: msgId } : {}),
      }));
      sock.end(lines.join('\n') + '\n', () => finish({ ok: true }));
    });
  });
}
