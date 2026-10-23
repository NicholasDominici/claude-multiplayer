// Discovery test: the "teammate found" notice that saves Claude from polling,
// and the message when two sessions speak different protocol versions.
// Runs real servers with fake inbox sockets on private discovery ports.
// Usage: node test/discovery.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-disc-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? `\n     ${detail}` : ''}`);
  if (!ok) failures++;
}

async function waitFor(fn, ms = 10000) {
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

/** Starts one MCP server; `room` keeps scenarios apart (own state dir and discovery port). */
function startServer(name, room, env = {}) {
  const inbox = fakeInbox(name);
  const child = spawn(process.execPath, [path.join(root, 'server/mcp.mjs')], {
    env: {
      ...process.env,
      CLAUDE_CODE_MESSAGING_SOCKET: inbox.sockPath,
      MULTIPLAYER_STATE_DIR: path.join(tmp, `state-${room}`),
      MULTIPLAYER_DISCOVERY_PORT: String(47930 + room),
      MULTIPLAYER_NAME: name,
      MULTIPLAYER_FOUND_NOTICE_MS: '800',
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
  const call = (tool, args = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, (r) => resolve({ text: r.result?.content?.[0]?.text ?? JSON.stringify(r), isError: r.result?.isError === true }));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } }) + '\n');
    });
  return { call, inbox };
}

try {
  // 1. Alice joins and returns at once. When Bob shows up later, her Claude gets
  // a notice instead of polling. Bob may already see Alice in his own join result.
  const A = startServer('Alice', 1);
  const joinA = await A.call('multiplayer_join', { wait_seconds: 0 });
  check('Alice finds nobody at first', /No other session found yet/.test(joinA.text), joinA.text);
  await sleep(1000);
  const B = startServer('Bob', 1);
  const joinB = await B.call('multiplayer_join', { wait_seconds: 0 });
  const foundA = await waitFor(() => A.inbox.users().find((u) => /Bob on .* is looking for a teammate too/.test(u.message.content)));
  const foundB = await waitFor(() => /name: Alice/.test(joinB.text) || B.inbox.users().find((u) => /Alice on .* is looking for a teammate too/.test(u.message.content)));
  check('Alice gets a notice when Bob shows up', !!foundA);
  check('Bob learns of Alice from his join result or a notice', !!foundB, joinB.text);
  check('found notice interrupts (priority next)', foundA?.priority === 'next', JSON.stringify(foundA));
  const codeA = /code (\d{3} \d{3})/.exec(foundA?.message.content ?? '')?.[1];
  const codeB = /code: (\d{3} \d{3})/.exec(joinB.text)?.[1] ?? /code (\d{3} \d{3})/.exec(foundB?.message?.content ?? '')?.[1];
  check('both sides show the same code', codeA && codeA === codeB, `${codeA} vs ${codeB}`);
  check('notice gives the peer_id to pair with', /multiplayer_pair with peer_id "[0-9a-f]{12}"/.test(foundA?.message.content ?? ''));

  await A.call('multiplayer_join', { wait_seconds: 5 });
  await sleep(1500);
  const countA = A.inbox.users().filter((u) => /looking for a teammate too/.test(u.message.content)).length;
  check('no second found notice for the same session', countA === 1, `got ${countA}`);

  // 2. A session that was listed by a join call gets no notice afterwards.
  const C = startServer('Carol', 2);
  const D = startServer('Dan', 2);
  const [joinC] = await Promise.all([C.call('multiplayer_join', { wait_seconds: 20 }), D.call('multiplayer_join', { wait_seconds: 20 })]);
  check('Carol finds Dan in the join result', /name: Dan/.test(joinC.text), joinC.text);
  await sleep(2000);
  check('no found notice after a join call listed the session', !C.inbox.users().some((u) => /looking for a teammate too/.test(u.message.content)));

  // 3. Different protocol versions: neither lists the other, both say who must update.
  const E = startServer('Erin', 3, { MULTIPLAYER_PROTO_VERSION: '2' });
  const F = startServer('Frank', 3);
  await E.call('multiplayer_join', { wait_seconds: 0 });
  const joinF = await F.call('multiplayer_join', { wait_seconds: 6 });
  check('newer peer is not listed as a candidate', !/name: Erin/.test(joinF.text), joinF.text);
  check('older side is told that it must update', /Version problem: Erin .*protocol 2.* your user must update/.test(joinF.text), joinF.text);
  check('update command is named', /curl -fsSL https:\/\/raw\.githubusercontent\.com\/NicholasDominici\/multiplayer\/main\/install\.sh \| sh/.test(joinF.text), joinF.text);
  const noticeE = await waitFor(() => E.inbox.users().find((u) => /cannot pair/.test(u.message.content)));
  check('newer side gets a notice that the teammate must update', /Frank must update/.test(noticeE?.message.content ?? ''), JSON.stringify(noticeE));
} finally {
  for (const c of children) c.kill();
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
