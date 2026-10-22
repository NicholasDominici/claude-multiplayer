// Live Codex test: pairs a real `codex exec` session with a scripted Claude Code
// side and has Codex do a small task over the link. It uses your Codex login
// and spends a little of your Codex usage, so it is not part of the default
// test run. Run it before a release.
//
// Codex runs with a throwaway CODEX_HOME: the plugin is installed there from
// this repo, and your auth.json is copied in and deleted again when the test
// ends, pass or fail. Your own Codex config is not touched.
//
// Usage: node test/codex-live.mjs [--keep]
//   --keep  keeps the work folder (Codex transcript and shared folders) for a look afterwards.
// Env: CODEX_AUTH  path to the auth.json to copy (default: $CODEX_HOME/auth.json or ~/.codex/auth.json)
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`     ${new Date().toISOString().slice(11, 19)} ${m}`);
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? `\n     ${detail}` : ''}`);
  if (!ok) failures++;
}

function codexBin() {
  try {
    return execFileSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const codex = codexBin();
const authSrc = process.env.CODEX_AUTH || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
if (!codex || !fs.existsSync(authSrc)) {
  console.log(`SKIP codex-live: ${!codex ? 'codex is not installed' : `no Codex login at ${authSrc}`}`);
  process.exit(0);
}

// Unique names, so other multiplayer sessions on this machine or network cannot be mistaken for the teammate.
const tag = crypto.randomBytes(2).toString('hex');
const ALICE = `Alice${tag}`;
const BOB = `Bob${tag}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-live-'));
const codexHome = path.join(tmp, 'codex-home');
const work = path.join(tmp, 'work');
const aliceDir = path.join(tmp, 'alice-shared');
const bobDir = path.join(work, 'shared');
const transcript = path.join(tmp, 'codex.jsonl');
fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(work, { recursive: true });

const children = [];
function cleanup() {
  for (const c of children) c.kill();
  fs.rmSync(path.join(codexHome, 'auth.json'), { force: true });
  if (keep) fs.rmSync(codexHome, { recursive: true, force: true });
  else fs.rmSync(tmp, { recursive: true, force: true });
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

// Codex side: a throwaway home with the plugin from this repo.
fs.copyFileSync(authSrc, path.join(codexHome, 'auth.json'));
fs.chmodSync(path.join(codexHome, 'auth.json'), 0o600);
const codexEnv = { ...process.env, CODEX_HOME: codexHome };
execFileSync(codex, ['plugin', 'marketplace', 'add', root], { env: codexEnv, stdio: 'ignore' });
execFileSync(codex, ['plugin', 'add', 'multiplayer@claude-multiplayer'], { env: codexEnv, stdio: 'ignore' });

// Claude Code side: the real server with a fake inbox socket, driven by this script.
const inbox = [];
const sockPath = path.join(tmp, 'inbox.sock');
net.createServer((s) => {
  let buf = '';
  s.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (line.type === 'user') {
        inbox.push(line);
        log(`${ALICE} inbox: ${line.message.content.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
  });
}).listen(sockPath);

const alice = spawn(process.execPath, [path.join(root, 'server/mcp.mjs')], {
  env: { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: sockPath, MULTIPLAYER_NAME: ALICE },
  stdio: ['pipe', 'pipe', 'inherit'],
});
children.push(alice);
let nextId = 1;
const pending = new Map();
let abuf = '';
alice.stdout.on('data', (d) => {
  abuf += d;
  let i;
  while ((i = abuf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(abuf.slice(0, i));
    abuf = abuf.slice(i + 1);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    alice.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
const call = async (tool, args = {}) => (await request('tools/call', { name: tool, arguments: args })).result?.content?.[0]?.text ?? '';

await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'codex-live' } });
await call('multiplayer_join', { shared_dir: aliceDir, wait_seconds: 0 });

const prompt = [
  `Use the multiplayer skill ($multiplayer) with these arguments: name=${BOB} dir=${bobDir}`,
  `I am your user. I have already checked with my teammate that the pairing code matches, so pair with the session named ${ALICE} without asking me.`,
  'Ignore any other session you find.',
  `After pairing, wait for a task from ${ALICE}'s agent: call multiplayer_inbox with wait_seconds 110, up to 4 times.`,
  `Do the task, reply to ${ALICE} with multiplayer_message, then end. Do not call multiplayer_leave.`,
].join('\n');
const out = fs.openSync(transcript, 'w');
const bob = spawn(codex, ['exec', '--json', '--skip-git-repo-check', '-C', work, '-s', 'workspace-write', '-c', 'approval_policy="never"', prompt], {
  env: codexEnv,
  stdio: ['ignore', out, out],
});
children.push(bob);
let bobExit = null;
bob.on('exit', (code) => {
  bobExit = code;
});
log(`codex exec started as ${BOB}`);

// Pair with Bob once he shows up (up to 3 minutes).
let bobId = null;
let listing = '';
for (let i = 0; i < 18 && !bobId && bobExit === null; i++) {
  const t = await call('multiplayer_join', { wait_seconds: 10 });
  listing = t.split('\n').find((l) => l.includes(`name: ${BOB} `)) ?? '';
  bobId = /peer_id: ([0-9a-f]{12})/.exec(listing)?.[1];
}
check(`${ALICE} finds ${BOB}`, !!bobId, `codex exited with ${bobExit}; transcript: ${transcript}`);
check(`${BOB} is listed as a Codex session`, /agent: Codex/.test(listing), listing);

let paired = '';
for (let i = 0; i < 3 && bobId && !/^Paired with/.test(paired); i++) {
  paired = await call('multiplayer_pair', { peer_id: bobId, accept: true, wait_seconds: 110 });
}
check('pairing completes', /^Paired with/.test(paired), paired);
check(`${ALICE} is told that ${BOB} uses pull delivery`, /uses pull delivery: your messages wait/.test(paired), paired);

const fromBob = (re) => inbox.find((u) => u.message.content.includes(`Message from ${BOB}'s Codex`) && re.test(u.message.content));
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !fn() && bobExit === null) await sleep(500);
  return fn();
};

if (/^Paired with/.test(paired)) {
  check(`${BOB}'s Codex sends a kickoff message`, !!(await until(() => fromBob(/./), 60_000)));
  const task = 'Please create hello.txt in the shared folder containing exactly the text: hi from codex. Reply to me when it is done.';
  const sent = await call('multiplayer_message', { text: task, delivery: 'steer' });
  check('the steer is queued for pull delivery', /^Queued for/.test(sent), sent);

  const reply = await until(() => fromBob(/hello\.txt|done/i), 6 * 60_000);
  check(`${BOB}'s Codex replies when the task is done`, !!reply);
  await sleep(2500);
  const file = path.join(aliceDir, 'hello.txt');
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
  check('the file Codex wrote synced to the Claude side', content === 'hi from codex', JSON.stringify(content));

  await until(() => bobExit !== null, 60_000);
  await sleep(1500);
  check(`${ALICE} gets a notice when Codex ends the session`, inbox.some((u) => u.message.content.includes(`${BOB} ended the multiplayer session`)));
}

let events = [];
try {
  events = fs.readFileSync(transcript, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
} catch {}
const toolCalls = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call').map((e) => e.item.tool);
check('Codex used multiplayer_inbox to wait', toolCalls.includes('multiplayer_inbox'), toolCalls.join(', '));
check('no Codex tool call was refused', !events.some((e) => e.item?.type === 'mcp_tool_call' && e.item.error), JSON.stringify(events.filter((e) => e.item?.error).map((e) => e.item.error)));

if (keep) console.log(`\nKept ${tmp} (Codex transcript: ${transcript}).`);
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
