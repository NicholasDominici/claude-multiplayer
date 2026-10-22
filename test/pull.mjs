// Mixed-agent test: a Claude Code session (push delivery through a fake inbox
// socket) pairs with a Codex-like session that has no inbox socket (pull
// delivery). Checks the agent and delivery fields, queued messages riding on
// tool results, multiplayer_inbox, and the fallback when a push fails.
// Usage: node test/pull.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-pull-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? `\n     ${detail}` : ''}`);
  if (!ok) failures++;
}

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(100);
  }
  return fn();
}

function fakeInbox(name) {
  const sockPath = path.join(tmp, `${name}.sock`);
  const lines = [];
  const server = net.createServer((s) => {
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
  return { sockPath, server, users: () => lines.filter((l) => l.type === 'user') };
}

function startServer(name, env) {
  const child = spawn(process.execPath, [path.join(root, 'server/mcp.mjs')], {
    env: {
      ...process.env,
      CLAUDE_CODE_MESSAGING_SOCKET: '',
      MULTIPLAYER_STATE_DIR: path.join(tmp, 'state'),
      MULTIPLAYER_DISCOVERY_PORT: '47940',
      MULTIPLAYER_NAME: name,
      ...env,
    },
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
    return { text: r.result?.content?.[0]?.text ?? JSON.stringify(r), isError: r.result?.isError === true };
  };
  return { request, call };
}

const inboxA = fakeInbox('alice');
const A = startServer('Alice', { CLAUDE_CODE_MESSAGING_SOCKET: inboxA.sockPath });
const B = startServer('Bob', { MULTIPLAYER_NO_INBOX: '1' });

try {
  await A.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '0' } });
  const initB = await B.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0' } });
  check('pull session is told in its server instructions', /not pushed into this session/.test(initB.result?.instructions ?? ''), initB.result?.instructions);

  const [joinA, joinB] = await Promise.all([
    A.call('multiplayer_join', { shared_dir: path.join(tmp, 'shared-a'), wait_seconds: 20 }),
    B.call('multiplayer_join', { shared_dir: path.join(tmp, 'shared-b'), wait_seconds: 20 }),
  ]);
  check('Alice sees that Bob runs Codex', /name: Bob .* agent: Codex/.test(joinA.text), joinA.text);
  check('Bob sees that Alice runs Claude Code', /name: Alice .* agent: Claude Code/.test(joinB.text), joinB.text);
  const bobId = /peer_id: ([0-9a-f]{12})  name: Bob/.exec(joinA.text)?.[1];
  const aliceId = /peer_id: ([0-9a-f]{12})  name: Alice/.exec(joinB.text)?.[1];

  const [pairA, pairB] = await Promise.all([
    A.call('multiplayer_pair', { peer_id: bobId, accept: true, wait_seconds: 30 }),
    B.call('multiplayer_pair', { peer_id: aliceId, accept: true, wait_seconds: 30 }),
  ]);
  check('Alice is told that Bob uses pull delivery', /Bob's Codex uses pull delivery/.test(pairA.text), pairA.text);
  check('Bob is told to call multiplayer_inbox', /This session uses pull delivery.*multiplayer_inbox/s.test(pairB.text), pairB.text);

  const m1 = await A.call('multiplayer_message', { text: 'Taking the API layer. Please take the CLI.', delivery: 'steer' });
  check('steer to a pull session is queued, not delivered mid-turn', /^Queued for Bob's Codex.*cannot interrupt/.test(m1.text), m1.text);

  const s1 = await B.call('multiplayer_status');
  check('Bob status shows pull delivery', /Delivery: pull/.test(s1.text), s1.text);
  check('queued message rides on Bob\'s next tool result', /Message from Alice's Claude Code \(steer[\s\S]*Taking the API layer/.test(s1.text), s1.text);
  const s2 = await B.call('multiplayer_status');
  check('a queued message is handed over only once', !/--- \d+ teammate message/.test(s2.text), s2.text);

  const r1 = await B.call('multiplayer_message', { text: 'OK, the CLI is mine.', delivery: 'fyi' });
  check('Bob reply is pushed to Alice', /^Delivered to Alice's Claude Code/.test(r1.text), r1.text);
  const gotA = await waitFor(() => inboxA.users().find((u) => /CLI is mine/.test(u.message.content)));
  check('Alice inbox names Bob\'s agent', /Message from Bob's Codex/.test(gotA?.message.content ?? ''), JSON.stringify(gotA));

  const started = Date.now();
  const waiting = B.call('multiplayer_inbox', { wait_seconds: 20 });
  await sleep(1000);
  await A.call('multiplayer_message', { text: 'The API types are in api/types.ts.', delivery: 'fyi' });
  const w = await waiting;
  check('multiplayer_inbox returns as soon as a message arrives', /api\/types\.ts/.test(w.text) && Date.now() - started < 8000, `${Date.now() - started} ms: ${w.text}`);
  const empty = await B.call('multiplayer_inbox');
  check('empty inbox says so', empty.text === 'No new teammate messages.', empty.text);

  // Alice's inbox socket goes away: her messages queue instead of being lost.
  await new Promise((r) => inboxA.server.close(r));
  fs.rmSync(inboxA.sockPath, { force: true });
  const r2 = await B.call('multiplayer_message', { text: 'CLI skeleton is in cli/.', delivery: 'fyi' });
  check('a failed push is queued, not dropped', /^Queued for Alice's Claude Code/.test(r2.text), r2.text);
  const sA = await A.call('multiplayer_status');
  check('the queued message rides on Alice\'s next tool result', /CLI skeleton is in cli\//.test(sA.text), sA.text);

  await A.call('multiplayer_leave');
  await sleep(1500);
  const sB = await B.call('multiplayer_status');
  check('notices queue for a pull session too', /Alice ended the multiplayer session/.test(sB.text), sB.text);
} finally {
  for (const c of children) c.kill();
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
