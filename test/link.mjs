// In-process link test: decline, the delayed "peer accepted" notice, and reconnect after a dropped link.
// Usage: node test/link.mjs
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-link-'));
const sockPath = path.join(tmp, 'inbox.sock');
const inbox = [];
const server = net.createServer((s) => {
  let buf = '';
  s.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      inbox.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
});
server.listen(sockPath);
Object.assign(process.env, {
  CLAUDE_CODE_MESSAGING_SOCKET: sockPath,
  MULTIPLAYER_STATE_DIR: path.join(tmp, 'state'),
  MULTIPLAYER_ACCEPT_NOTICE_MS: '500',
});
const { Multiplayer } = await import('../server/multiplayer.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? `\n     ${detail}` : ''}`);
  if (!ok) failures++;
};
async function waitFor(fn, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(100);
  }
  return !!fn();
}
const idIn = (text, name) => new RegExp(`peer_id: ([0-9a-f]{12})  name: ${name}`).exec(text)?.[1];

try {
  // Decline, with the delayed notice on the side that has not answered yet.
  const x = new Multiplayer();
  const y = new Multiplayer();
  const [jx, jy] = await Promise.all([
    x.join({ name: 'Xena', shared_dir: path.join(tmp, 'x'), wait_seconds: 15 }),
    y.join({ name: 'Yuri', shared_dir: path.join(tmp, 'y'), wait_seconds: 15 }),
  ]);
  const pairX = x.pair({ peer_id: idIn(jx.text, 'Yuri'), accept: true, wait_seconds: 10 });
  const noticed = await waitFor(() => inbox.some((l) => l.type === 'user' && /Xena on .* accepted pairing/.test(l.message.content)), 4000);
  check('undecided side gets a delayed "accepted pairing" notice', noticed);
  await y.pair({ peer_id: idIn(jy.text, 'Xena'), accept: false });
  const rx = await pairX;
  check('decline reaches the accepting side', /declined/.test(rx.text), rx.text);
  await x.leave();
  await y.leave();

  // Reconnect after the link drops.
  const p = new Multiplayer();
  const q = new Multiplayer();
  const [jp, jq] = await Promise.all([
    p.join({ name: 'Pia', shared_dir: path.join(tmp, 'p'), wait_seconds: 15 }),
    q.join({ name: 'Quinn', shared_dir: path.join(tmp, 'q'), wait_seconds: 15 }),
  ]);
  await Promise.all([
    p.pair({ peer_id: idIn(jp.text, 'Quinn'), accept: true }),
    q.pair({ peer_id: idIn(jq.text, 'Pia'), accept: true }),
  ]);
  check('pair goes live', p.state === 'live' && q.state === 'live');
  p.liveConn.sock.destroy();
  await sleep(300);
  check('drop is seen as disconnected', p.state === 'disconnected' || q.state === 'disconnected', `${p.state}/${q.state}`);
  const back = await waitFor(() => p.state === 'live' && q.state === 'live');
  check('link reconnects on its own without a new code check', back, `${p.state}/${q.state}`);
  const m = await p.message({ text: 'After reconnect: still here.', delivery: 'fyi' });
  check('messages work after reconnect', /^Delivered/.test(m.text), m.text);
  check('one link per peer after reconnect', p.conns.size === 1 && q.conns.size === 1, `${p.conns.size}/${q.conns.size}`);
  await p.leave();
  await q.leave();
} catch (err) {
  console.error(err);
  failures++;
} finally {
  console.log(failures ? `\n${failures} check(s) failed. Temp dir: ${tmp}` : '\nAll checks passed.');
  if (!failures) fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
