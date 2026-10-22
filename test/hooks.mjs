// Codex hook test: runs bin/codex-hook.sh the way Codex runs it (a child of
// the process that also started the MCP server) against a real server paired
// with a push session. Checks that steers come out of PostToolUse, the rest
// out of Stop and UserPromptSubmit, and that the teammate learns about it.
// Usage: node test/hooks.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-hooks-'));
const stateDir = path.join(tmp, 'state');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? `\n     ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Runs the hook like Codex does: sh, hook input on stdin, from this process. */
function hook(event) {
  const started = Date.now();
  const r = spawnSync('sh', [path.join(root, 'bin/codex-hook.sh'), event], {
    input: JSON.stringify({ hook_event_name: event, session_id: 'test' }),
    env: { ...process.env, MULTIPLAYER_STATE_DIR: stateDir },
    encoding: 'utf8',
  });
  let json = null;
  try {
    json = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  } catch {}
  return { code: r.status, out: r.stdout.trim(), json, ms: Date.now() - started };
}

function fakeInbox(name) {
  const sockPath = path.join(tmp, `${name}.sock`);
  const lines = [];
  net.createServer((s) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
  }).listen(sockPath);
  return { sockPath, users: () => lines.filter((l) => l.type === 'user') };
}

function startServer(name, env, clientName) {
  const child = spawn(process.execPath, [path.join(root, 'server/mcp.mjs')], {
    env: { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: '', MULTIPLAYER_STATE_DIR: stateDir, MULTIPLAYER_DISCOVERY_PORT: '47960', MULTIPLAYER_NAME: name, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  children.push(child);
  let nextId = 1;
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const call = async (tool, args = {}) => {
    const r = await request('tools/call', { name: tool, arguments: args });
    return r.result?.content?.[0]?.text ?? JSON.stringify(r);
  };
  return { child, call, init: () => request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: clientName, version: '0' } }) };
}

try {
  const idle = hook('post-tool-use');
  check('outside multiplayer the hook prints nothing and exits 0', idle.code === 0 && idle.out === '', JSON.stringify(idle));

  const inboxA = fakeInbox('alice');
  const A = startServer('Alice', { CLAUDE_CODE_MESSAGING_SOCKET: inboxA.sockPath }, 'claude-code');
  const B = startServer('Bob', { MULTIPLAYER_NO_INBOX: '1' }, 'codex-mcp-client');
  await A.init();
  await B.init();
  const [jA, jB] = await Promise.all([
    A.call('multiplayer_join', { shared_dir: path.join(tmp, 'a'), wait_seconds: 20 }),
    B.call('multiplayer_join', { shared_dir: path.join(tmp, 'b'), wait_seconds: 20 }),
  ]);
  const bobId = /peer_id: ([0-9a-f]{12})  name: Bob/.exec(jA)?.[1];
  const aliceId = /peer_id: ([0-9a-f]{12})  name: Alice/.exec(jB)?.[1];
  const [, pB] = await Promise.all([
    A.call('multiplayer_pair', { peer_id: bobId, accept: true, wait_seconds: 30 }),
    B.call('multiplayer_pair', { peer_id: aliceId, accept: true, wait_seconds: 30 }),
  ]);
  check('before any hook runs, Codex is told how to turn hooks on', /open \/hooks and trust the multiplayer hooks/.test(pB), pB);
  check('the control socket exists while multiplayer is on', fs.readdirSync(path.join(stateDir, 'ctl')).some((n) => n.endsWith('.sock')));

  const first = hook('post-tool-use');
  check('a hook with nothing waiting prints nothing', first.code === 0 && first.out === '', JSON.stringify(first));
  await sleep(500);
  const sA = await A.call('multiplayer_status');
  check('the teammate learns that Codex now takes push delivery', /Teammate: Bob's Codex .*delivery push/.test(sA), sA);
  const sB = await B.call('multiplayer_status');
  check('Codex status says push through the hooks', /Delivery: push .*through the Codex hooks/.test(sB), sB);

  const m1 = await A.call('multiplayer_message', { text: 'Stop editing api.ts, I am changing it.', delivery: 'steer' });
  check('sender is told the steer lands after the next tool call', /^Delivered to Bob's Codex\. It reads it after its next tool call/.test(m1), m1);
  const steer = hook('post-tool-use');
  check('PostToolUse hands the steer to Codex as additionalContext',
    steer.json?.hookSpecificOutput?.hookEventName === 'PostToolUse' && /Stop editing api\.ts/.test(steer.json?.hookSpecificOutput?.additionalContext ?? ''), steer.out);
  check('the hook is quick', steer.ms < 1500, `${steer.ms} ms`);
  check('a steer is handed over only once', hook('post-tool-use').out === '');

  await B.call('multiplayer_message', { text: 'OK, I will leave api.ts alone.', delivery: 'fyi' });
  await A.call('multiplayer_message', { text: 'Thanks. The types are in types.ts.', delivery: 'fyi' });
  check('PostToolUse does not hand over an fyi', hook('post-tool-use').out === '');
  const stop = hook('stop');
  check('Stop continues the turn with the fyi', stop.json?.decision === 'block' && /types are in types\.ts/.test(stop.json?.reason ?? ''), stop.out);
  check('Stop with nothing waiting lets the turn end', hook('stop').out === '');

  await B.call('multiplayer_message', { text: 'Got it.', delivery: 'fyi' });
  await A.call('multiplayer_message', { text: 'One more thing for later.', delivery: 'fyi' });
  const prompt = hook('user-prompt-submit');
  check('UserPromptSubmit hands over what waited while Codex was idle',
    prompt.json?.hookSpecificOutput?.hookEventName === 'UserPromptSubmit' && /One more thing for later/.test(prompt.json?.hookSpecificOutput?.additionalContext ?? ''), prompt.out);

  B.child.kill('SIGTERM');
  await sleep(800);
  check('the control socket is removed when the session ends', !fs.readdirSync(path.join(stateDir, 'ctl')).some((n) => n.endsWith('.sock')));
} finally {
  for (const c of children) c.kill();
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
