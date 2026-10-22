// End-to-end test: runs two real multiplayer MCP servers on this machine, each
// with a fake Claude Code inbox socket, and drives them like Claude would.
// Usage: node test/e2e.mjs [--udp-only]
//   --udp-only  turns off same-machine file discovery, so pairing must use LAN UDP.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeRelPath } from '../server/sync.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const udpOnly = process.argv.includes('--udp-only');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  });
  server.listen(sockPath);
  return { sockPath, lines, server, users: () => lines.filter((l) => l.type === 'user') };
}

function startServer(name, inbox) {
  const child = spawn(process.execPath, [path.join(root, 'server/mcp.mjs')], {
    env: {
      ...process.env,
      CLAUDE_CODE_MESSAGING_SOCKET: inbox.sockPath,
      CLAUDE_CODE_MESSAGING_TOKEN: `token-${name}`,
      MULTIPLAYER_STATE_DIR: path.join(tmp, 'state'),
      MULTIPLAYER_NAME: name,
      ...(udpOnly ? { MULTIPLAYER_NO_REGISTRY: '1' } : {}),
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
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
  return { child, request, call };
}

const inboxA = fakeInbox('alice');
const inboxB = fakeInbox('bob');
const A = startServer('Alice', inboxA);
const B = startServer('Bob', inboxB);
const dirA = path.join(tmp, 'shared-a');
const dirB = path.join(tmp, 'shared-b');

try {
  const init = await A.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '0' } });
  check('initialize returns server info', init.result?.serverInfo?.name === 'multiplayer', JSON.stringify(init));
  await B.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '0' } });
  const tools = await A.request('tools/list', {});
  check('six tools listed', tools.result?.tools?.length === 6);

  const [joinA, joinB] = await Promise.all([
    A.call('multiplayer_join', { shared_dir: dirA, wait_seconds: 20 }),
    B.call('multiplayer_join', { shared_dir: dirB, wait_seconds: 20 }),
  ]);
  const idOf = (t, who) => new RegExp(`peer_id: ([0-9a-f]{12})  name: ${who}`).exec(t)?.[1];
  const codeOf = (t, who) => new RegExp(`name: ${who} .* code: (\\d{3} \\d{3})`).exec(t)?.[1];
  const bobId = idOf(joinA.text, 'Bob');
  const aliceId = idOf(joinB.text, 'Alice');
  check('Alice finds Bob', !!bobId, joinA.text);
  check('Bob finds Alice', !!aliceId, joinB.text);
  check('both screens show the same code', codeOf(joinA.text, 'Bob') && codeOf(joinA.text, 'Bob') === codeOf(joinB.text, 'Alice'), `${codeOf(joinA.text, 'Bob')} vs ${codeOf(joinB.text, 'Alice')}`);

  // Alice accepts first; Bob accepts 3 s later, as a slower human would.
  const pairA = A.call('multiplayer_pair', { peer_id: bobId, accept: true, wait_seconds: 30 });
  await sleep(3000);
  const pairB = await B.call('multiplayer_pair', { peer_id: aliceId, accept: true, wait_seconds: 30 });
  const pairedA = await pairA;
  check('Alice pair call returns paired', /^Paired with Bob/.test(pairedA.text), pairedA.text);
  check('Bob pair call returns paired', /^Paired with Alice/.test(pairB.text), pairB.text);
  check('Bob got no early "accepted" notice while his user compared codes', !inboxB.users().some((u) => /accepted pairing/.test(u.message.content)));

  const notes = await waitFor(() => fs.existsSync(path.join(dirA, 'NOTES.md')) && fs.existsSync(path.join(dirB, 'NOTES.md')));
  check('NOTES.md board seeded and synced', notes);

  // Steer message Alice -> Bob.
  const m1 = await A.call('multiplayer_message', { text: 'I am taking the API layer in api/. Please take the UI.', delivery: 'steer' });
  check('steer message delivered with receipt', /^Delivered to Bob/.test(m1.text), m1.text);
  const got = await waitFor(() => inboxB.users().find((u) => /API layer/.test(u.message.content)));
  check('Bob inbox got a user line', !!got);
  check('steer maps to priority next', got?.priority === 'next', JSON.stringify(got));
  check('message names the sender and the reply tool', /Message from Alice's Claude/.test(got?.message.content) && /multiplayer_message/.test(got?.message.content));
  check('auth line sent first with the session token', inboxB.lines[0]?.type === 'auth' && inboxB.lines[0]?.token === 'token-Bob', JSON.stringify(inboxB.lines[0]));

  const m2 = await A.call('multiplayer_message', { text: 'Second steer right away.', delivery: 'steer' });
  check('second steer within 90 s is refused', m2.isError && /wait \d+s/.test(m2.text), m2.text);

  const r1 = await B.call('multiplayer_message', { text: 'OK: UI is mine. I will read api/types.ts for the contract.', delivery: 'fyi' });
  check('reply to a fresh message is allowed', /^Delivered to Alice/.test(r1.text), r1.text);
  const fyi = await waitFor(() => inboxA.users().find((u) => /UI is mine/.test(u.message.content)));
  check('fyi maps to priority later', fyi?.priority === 'later', JSON.stringify(fyi));
  const r2 = await B.call('multiplayer_message', { text: 'Another one immediately.', delivery: 'fyi' });
  check('a second fyi right after is refused', r2.isError, r2.text);
  const long = await A.call('multiplayer_message', { text: 'x'.repeat(2000), delivery: 'fyi' });
  check('over-long message is refused', long.isError && /limit/.test(long.text));

  // Folder sync.
  fs.mkdirSync(path.join(dirA, 'api'), { recursive: true });
  fs.writeFileSync(path.join(dirA, 'api', 'types.ts'), 'export type User = { id: string };\n');
  const synced = await waitFor(() => fs.existsSync(path.join(dirB, 'api', 'types.ts')) && fs.readFileSync(path.join(dirB, 'api', 'types.ts'), 'utf8').includes('User'));
  check('new file in A appears in B', synced);
  await sleep(1200);
  fs.writeFileSync(path.join(dirB, 'api', 'types.ts'), 'export type User = { id: string; name: string };\n');
  const back = await waitFor(() => fs.readFileSync(path.join(dirA, 'api', 'types.ts'), 'utf8').includes('name: string'));
  check('edit in B flows back to A', back);
  await sleep(1200);
  fs.writeFileSync(path.join(dirB, 'scratch.md'), 'temp\n');
  await waitFor(() => fs.existsSync(path.join(dirA, 'scratch.md')));
  await sleep(1200);
  fs.rmSync(path.join(dirA, 'scratch.md'));
  const gone = await waitFor(() => !fs.existsSync(path.join(dirB, 'scratch.md')));
  check('delete in A removes the file in B', gone);
  const trashed = fs.existsSync(path.join(dirB, '.multiplayer', 'trash')) && JSON.stringify(fs.readdirSync(path.join(dirB, '.multiplayer', 'trash'), { recursive: true })).includes('scratch.md');
  check('deleted file is kept in B trash, not unlinked', trashed);
  fs.writeFileSync(path.join(dirA, 'big.bin'), Buffer.alloc(9 * 1024 * 1024));
  await sleep(2500);
  check('file over 8 MB is not synced', !fs.existsSync(path.join(dirB, 'big.bin')));

  // Path safety.
  check('rejects ../ escape', safeRelPath('../etc/passwd') === null);
  check('rejects absolute path', safeRelPath('/etc/passwd') === null);
  check('rejects .git content', safeRelPath('repo/.git/config') === null);
  check('rejects backslash path', safeRelPath('a\\..\\b') === null);
  check('accepts normal nested path', safeRelPath('src/app/main.ts') === 'src/app/main.ts');

  const st = await A.call('multiplayer_status');
  check('status shows live state and teammate', /State: live/.test(st.text) && /Teammate: Bob/.test(st.text), st.text);

  // Leave.
  const left = await A.call('multiplayer_leave');
  check('leave returns confirmation', /^Left the multiplayer session with Bob/.test(left.text), left.text);
  const byeNotice = await waitFor(() => inboxB.users().find((u) => /ended the multiplayer session/.test(u.message.content)));
  check('Bob gets a notice that Alice left', !!byeNotice);
  const stB = await B.call('multiplayer_status');
  check('Bob state is left', /State: left/.test(stB.text), stB.text);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  A.child.kill();
  B.child.kill();
  inboxA.server.close();
  inboxB.server.close();
  console.log(failures ? `\n${failures} check(s) failed. Temp dir: ${tmp}` : '\nAll checks passed.');
  if (!failures) fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
