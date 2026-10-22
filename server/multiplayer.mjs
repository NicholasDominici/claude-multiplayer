// Core of Claude Multiplayer: LAN discovery, pairing, the encrypted peer link,
// teammate messages, and notices into this agent session (Claude Code, Codex,
// or any MCP client).
//
// Flow: join() starts UDP beacons (multicast + broadcast) and a TCP listener.
// Each side lists the sessions it hears, with a 6-digit code derived from an
// X25519 key exchange. When a user confirms the code, pair() dials the peer and
// sends a sealed "accept". The link goes live when both sides have accepted.
// Live messages from the peer go into the agent: pushed through Claude Code's
// inbox socket when there is one, otherwise queued for the next tool result.
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { execFileSync } from 'node:child_process';
import { newIdentity, derivePair, seal, open } from './crypto.mjs';
import { deliverToClaude, findInboxSocket } from './inbox.mjs';
import { FolderSync } from './sync.mjs';

const PROTO = 'claude-multiplayer';
const PROTO_VERSION = Number(process.env.MULTIPLAYER_PROTO_VERSION) || 1;
const UPDATE_COMMAND = 'claude plugin update multiplayer@claude-multiplayer';
const DISCOVERY_PORT = Number(process.env.MULTIPLAYER_DISCOVERY_PORT) || 47823;
const TCP_PORT = Number(process.env.MULTIPLAYER_TCP_PORT) || 47824;
const MCAST_GROUP = '239.255.77.77';
const BEACON_MS = 2000;
const CANDIDATE_TTL_MS = 9000;
const SEARCH_MAX_MS = 30 * 60_000;
const RECONNECT_MAX_MS = 10 * 60_000;
const PENDING_CONN_MAX_MS = 10 * 60_000;
const PING_MS = 15_000;
const DEAD_LINK_MS = 45_000;
const MAX_LINE_CHARS = 40 * 1024 * 1024;
const MAX_INBOUND_PER_HOUR = 40;
const ACCEPT_NOTICE_DELAY_MS = Number(process.env.MULTIPLAYER_ACCEPT_NOTICE_MS) || 15_000;
const FOUND_NOTICE_DELAY_MS = Number(process.env.MULTIPLAYER_FOUND_NOTICE_MS) || 2_500;
const MAX_PENDING = 200;

/** The plugin version from plugin.json, shown to peers so a mismatch can name both versions. */
export const PLUGIN_VERSION = (() => {
  try {
    const manifest = new URL('../.claude-plugin/plugin.json', import.meta.url);
    return String(JSON.parse(fs.readFileSync(manifest, 'utf8')).version || 'unknown');
  } catch {
    return 'unknown';
  }
})();

/** Pacing for multiplayer_message: roughly how often a focused teammate pings a coworker. */
export const LIMITS = {
  maxChars: 1500,
  steerGapMs: 90_000,
  fyiGapMs: 20_000,
  perHour: 20,
  replyWindowMs: 5 * 60_000,
  duplicateWindowMs: 10 * 60_000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ID_RE = /^[0-9a-f]{12}$/;

function cleanName(value) {
  const name = String(value ?? '').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 32);
  return name || 'Teammate';
}

/** Normalizes an agent id such as "claude-code" or "codex-mcp-client". */
function cleanAgent(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);
}

/** Human name for an agent id. */
export function agentLabel(agent) {
  if (/claude/.test(agent)) return 'Claude Code';
  if (/codex/.test(agent)) return 'Codex';
  if (/cursor/.test(agent)) return 'Cursor';
  if (/gemini/.test(agent)) return 'Gemini CLI';
  return agent || 'agent';
}

/** "Bob's Codex", "Bob's Claude Code" */
function agentOf(c) {
  return `${c.name}'s ${agentLabel(c.agent)}`;
}

/** How a user starts multiplayer, for messages that the other side reads. */
const START_HINT = 'the multiplayer skill (/multiplayer:multiplayer in Claude Code, $multiplayer in Codex)';

function slug(value) {
  return String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'peer';
}

function defaultName() {
  if (process.env.MULTIPLAYER_NAME) return cleanName(process.env.MULTIPLAYER_NAME);
  try {
    const full = execFileSync('git', ['config', '--global', 'user.name'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (full) return cleanName(full.split(/\s+/)[0]);
  } catch {}
  const user = os.userInfo().username || 'teammate';
  return cleanName(user.charAt(0).toUpperCase() + user.slice(1));
}

function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/** Lists IPv4 LAN interfaces with their directed broadcast address. */
function lanInterfaces() {
  const out = [];
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = (a.netmask || '255.255.255.0').split('.').map(Number);
      const broadcast = ip.map((octet, i) => (octet | (~mask[i] & 255))).join('.');
      out.push({ ifname, address: a.address, broadcast, pointToPoint: a.netmask === '255.255.255.255' });
    }
  }
  return out;
}

function hint(err) {
  if (!err) return '';
  if (/EHOSTUNREACH|ENETUNREACH|EPERM|EACCES|EADDRNOTAVAIL/.test(err)) {
    return ' On macOS this usually means Local Network access is off: open System Settings > Privacy & Security > Local Network and turn it on for the app that runs your coding agent (Claude, Codex, Terminal, iTerm, VS Code), then call multiplayer_join again.';
  }
  return '';
}

export class Multiplayer {
  constructor() {
    this.id = crypto.randomBytes(6).toString('hex');
    this.identity = newIdentity();
    this.name = null;
    this.host = os.hostname().replace(/\.local$/i, '').slice(0, 64);
    this.stateDir = process.env.MULTIPLAYER_STATE_DIR || path.join(os.homedir(), '.claude-multiplayer');
    this.beaconDir = path.join(this.stateDir, 'beacons');
    this.logFile = path.join(this.stateDir, 'logs', `${this.id}.log`);
    // Push: messages go into the running session through Claude Code's inbox
    // socket. Pull: they wait in `pending` and ride along on the next
    // multiplayer tool result, so any MCP client can take part.
    this.inbox = process.env.MULTIPLAYER_NO_INBOX === '1' ? null : findInboxSocket();
    this.delivery = this.inbox ? 'push' : 'pull';
    this.agentOverride = cleanAgent(process.env.MULTIPLAYER_AGENT);
    this.agent = this.agentOverride || (this.inbox ? 'claude-code' : 'unknown');
    this.pending = [];
    this.inboxWaiters = new Set();

    this.state = 'idle'; // idle | searching | live | disconnected | left
    this.candidates = new Map();
    this.mismatches = new Map();
    this.conns = new Set();
    this.peer = null;
    this.liveConn = null;
    this.sync = null;
    this.sharedDir = null;
    this.sharedDirOverride = null;

    this.port = null;
    this.tcp = null;
    this.tcpReady = null;
    this.dialing = new Set();
    this.udpListener = null;
    this.udpSenders = [];
    this.udpSig = '';
    this.beaconTimer = null;
    this.searchUntil = 0;
    this.reconnectUntil = 0;
    this.pingTimer = null;
    this.errors = {};

    this.inFlight = 0;
    this.history = [];
    this.sentAt = [];
    this.inboundAt = [];
    this.lastSteerAt = 0;
    this.lastAnyOutAt = 0;
    this.lastInboundAt = 0;
    this.lastOutText = '';
    this.pendingReceipts = new Map();
    this.disconnectNoticeSent = false;
    this.leaving = false;
  }

  /** Takes the agent id from the MCP client's initialize request. */
  setClient(clientInfo) {
    if (this.agentOverride) return;
    this.agent = cleanAgent(clientInfo?.name) || this.agent;
  }

  log(msg) {
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, `${new Date().toISOString()} ${msg}\n`);
    } catch {}
  }

  // ---------------------------------------------------------------- tools

  /** multiplayer_join: start searching and wait for sessions to appear. */
  async join({ name, shared_dir, address, wait_seconds } = {}) {
    if (name) this.name = cleanName(name);
    if (!this.name) this.name = defaultName();
    if (shared_dir) this.sharedDirOverride = path.resolve(expandHome(String(shared_dir)));
    if (this.state === 'live') return { text: `Already paired with ${this.peer.name}.\n\n${this.liveSummary()}` };

    await this.ensureTcp();
    this.startSearch();
    if (address) this.dialAddress(String(address));

    const waitMs = Math.max(0, Math.min(110, Number(wait_seconds ?? 40))) * 1000;
    const deadline = Date.now() + waitMs;
    this.inFlight++;
    try {
      let firstSeenAt = 0;
      while (Date.now() < deadline && this.state !== 'live') {
        if (this.visibleCandidates().length > 0) {
          if (!firstSeenAt) firstSeenAt = Date.now();
          if (Date.now() - firstSeenAt > 1500) break;
        }
        await sleep(250);
      }
    } finally {
      this.inFlight--;
    }
    if (this.state === 'live') return { text: `Paired with ${this.peer.name}.\n\n${this.liveSummary()}` };
    return { text: this.searchSummary() };
  }

  /** multiplayer_pair: accept or decline one candidate; on accept, wait for the peer to accept too. */
  async pair({ peer_id, accept, wait_seconds } = {}) {
    const c = this.candidates.get(String(peer_id ?? ''));
    if (!c) return { error: true, text: 'Unknown peer_id. Call multiplayer_join to list the sessions on the network.' };
    if (accept === false) {
      c.rejected = true;
      c.accepted = false;
      for (const conn of this.connsFor(c.id)) {
        this.sendSealed(conn, { t: 'reject' });
        conn.sock.end();
      }
      return { text: `Declined ${c.name}. This session keeps searching; call multiplayer_join to see other sessions.` };
    }
    if (this.state === 'live' && this.peer && this.peer.id !== c.id) {
      return { error: true, text: `Already paired with ${this.peer.name}. Call multiplayer_leave first.` };
    }
    if (this.state === 'live') return { text: `Paired with ${c.name}.\n\n${this.liveSummary()}` };

    c.accepted = true;
    c.rejected = false;
    await this.ensureTcp();
    this.connectAccepted(c);

    const waitMs = Math.max(0, Math.min(110, Number(wait_seconds ?? 90))) * 1000;
    const deadline = Date.now() + waitMs;
    let lastDial = Date.now();
    this.inFlight++;
    try {
      while (Date.now() < deadline) {
        if (this.state === 'live' && this.peer?.id === c.id) break;
        if (c.peerRejected) break;
        if (this.connsFor(c.id).length === 0 && Date.now() - lastDial > 4000) {
          lastDial = Date.now();
          this.dialCandidate(c);
        }
        await sleep(250);
      }
    } finally {
      this.inFlight--;
    }
    if (this.state === 'live' && this.peer?.id === c.id) return { text: `Paired with ${c.name}.\n\n${this.liveSummary()}` };
    if (c.peerRejected) return { error: true, text: `${c.name} declined the pairing.` };
    return {
      text:
        `You accepted ${c.name} (code ${c.code}). Waiting for ${c.name} to confirm on their machine. ` +
        `The pairing completes on its own when they accept, and this session then gets a notice. ` +
        `Call multiplayer_pair again to keep waiting, or multiplayer_status to check.`,
    };
  }

  /** multiplayer_message: send one teammate message, paced by LIMITS. */
  async message({ text, delivery } = {}) {
    if (this.state !== 'live' || !this.liveConn) {
      const why = this.state === 'disconnected' ? `The link to ${this.peer?.name} is down; it reconnects on its own.` : `Not paired yet. Start ${START_HINT} first.`;
      return { error: true, text: `Not sent. ${why}` };
    }
    const body = String(text ?? '').trim();
    if (!body) return { error: true, text: 'Not sent: the message is empty.' };
    if (delivery !== 'steer' && delivery !== 'fyi') return { error: true, text: 'Not sent: delivery must be "steer" or "fyi".' };
    if (body.length > LIMITS.maxChars) {
      return { error: true, text: `Not sent: ${body.length} characters is over the ${LIMITS.maxChars} limit. Put the detail in a file in ${this.sharedDir} and send the path.` };
    }
    const now = Date.now();
    this.sentAt = this.sentAt.filter((t) => now - t < 3_600_000);
    if (this.sentAt.length >= LIMITS.perHour) {
      return { error: true, text: `Not sent: ${LIMITS.perHour} messages in the last hour is the limit. Keep working on your own and put updates in ${path.join(this.sharedDir, 'NOTES.md')}.` };
    }
    if (body === this.lastOutText && now - this.lastAnyOutAt < LIMITS.duplicateWindowMs) {
      return { error: true, text: 'Not sent: you sent the same message a moment ago.' };
    }
    const replying = this.lastInboundAt > this.lastAnyOutAt && now - this.lastInboundAt < LIMITS.replyWindowMs;
    if (!replying) {
      const wait = delivery === 'steer'
        ? LIMITS.steerGapMs - (now - this.lastSteerAt)
        : LIMITS.fyiGapMs - (now - this.lastAnyOutAt);
      if (wait > 0) {
        const s = Math.ceil(wait / 1000);
        return {
          error: true,
          text:
            `Not sent: wait ${s}s before the next ${delivery} message. Each message interrupts ${agentOf(this.peer)}, so batch this with your next update` +
            (delivery === 'steer' ? ', send it as fyi if it can wait,' : '') +
            ` or write it to ${path.join(this.sharedDir, 'NOTES.md')}.`,
        };
      }
    }

    const id = crypto.randomBytes(6).toString('hex');
    const receipt = new Promise((resolve) => {
      this.pendingReceipts.set(id, resolve);
      setTimeout(() => resolve(null), 4000).unref?.();
    });
    this.sendSealed(this.liveConn, { t: 'msg', id, text: body, delivery, ts: now });
    this.sentAt.push(now);
    this.lastAnyOutAt = now;
    this.lastOutText = body;
    if (delivery === 'steer') this.lastSteerAt = now;
    this.record('out', body, delivery);

    const r = await receipt;
    this.pendingReceipts.delete(id);
    const who = agentOf(this.peer);
    if (!r) return { text: `Sent to ${who}. No delivery receipt yet.` };
    if (!r.ok) return { error: true, text: `Sent, but ${who} could not take it: ${r.error}.` };
    if (r.queued) {
      return {
        text:
          `Queued for ${who}. It reads the message the next time it calls a multiplayer tool` +
          (delivery === 'steer' ? ', so this steer cannot interrupt it mid-turn.' : '.'),
      };
    }
    return {
      text: delivery === 'steer'
        ? `Delivered to ${who}. It reads it after its current tool call.`
        : `Delivered to ${who}. It reads it when its current turn ends.`,
    };
  }

  /** multiplayer_status */
  status() {
    const lines = [];
    lines.push(`State: ${this.state}`);
    lines.push(`This session: ${this.name ?? defaultName()} on ${this.host} (${this.myAddresses()}), agent ${agentLabel(this.agent)}`);
    lines.push(
      this.delivery === 'push'
        ? 'Delivery: push (teammate messages arrive on their own, mid-turn for a steer)'
        : `Delivery: pull (teammate messages wait until a multiplayer tool call; ${this.pending.length} waiting)`,
    );
    if (this.peer) {
      lines.push(`Teammate: ${agentOf(this.peer)} on ${this.peer.host} (${this.peer.ip}), code ${this.peer.code}, delivery ${this.peer.delivery}`);
    }
    if (this.sharedDir) lines.push(`Shared folder: ${this.sharedDir}`);
    if (this.sync) {
      const s = this.sync.stats;
      lines.push(`Sync: ${s.sent} sent, ${s.received} received, ${s.deleted} deleted, ${s.conflicts} conflicts, ${s.refused} refused`);
    }
    if (this.state === 'live') {
      const now = Date.now();
      const steerIn = Math.max(0, Math.ceil((LIMITS.steerGapMs - (now - this.lastSteerAt)) / 1000));
      const used = this.sentAt.filter((t) => now - t < 3_600_000).length;
      lines.push(`Messages this hour: ${used}/${LIMITS.perHour}. Next steer allowed in ${steerIn}s.`);
    }
    if (this.state === 'searching') lines.push(this.searchSummary());
    const recent = this.history.slice(-10);
    if (recent.length) {
      lines.push('Recent messages:');
      for (const h of recent) {
        const who = h.dir === 'in' ? `${this.peer?.name ?? 'teammate'} ->` : h.dir === 'out' ? '-> teammate' : 'notice';
        lines.push(`  ${new Date(h.at).toLocaleTimeString()} ${who} [${h.delivery}] ${h.text.replace(/\s+/g, ' ').slice(0, 200)}`);
      }
    }
    return { text: lines.join('\n') };
  }

  /** multiplayer_leave */
  async leave() {
    const peerName = this.peer?.name;
    const dir = this.sharedDir;
    this.leaving = true;
    if (this.liveConn) this.sendSealed(this.liveConn, { t: 'bye' });
    await sleep(150);
    for (const conn of [...this.conns]) conn.sock.destroy();
    this.stopSearch();
    this.resetPeer();
    this.candidates.clear();
    this.state = 'idle';
    this.leaving = false;
    return { text: `Left the multiplayer session${peerName ? ` with ${peerName}` : ''}.${dir ? ` The shared folder stays at ${dir}.` : ''}` };
  }

  /** Forgets the current teammate and stops syncing. */
  resetPeer() {
    this.sync?.stop();
    clearInterval(this.pingTimer);
    this.peer = null;
    this.liveConn = null;
    this.sync = null;
    this.sharedDir = null;
    this.disconnectNoticeSent = false;
  }

  /** Called when the agent closes the server. */
  async shutdown() {
    try {
      if (this.liveConn) {
        this.leaving = true;
        this.sendSealed(this.liveConn, { t: 'bye' });
        await sleep(100);
      }
      this.removeRegistry();
    } catch {}
  }

  // ------------------------------------------------------------- summaries

  myAddresses() {
    const ips = lanInterfaces().map((i) => i.address);
    return `${ips.length ? ips.join(', ') : 'no LAN address'}${this.port ? `, port ${this.port}` : ''}`;
  }

  visibleCandidates() {
    const now = Date.now();
    return [...this.candidates.values()].filter(
      (c) => !c.rejected && !c.peerRejected && (now - c.seenAt < CANDIDATE_TTL_MS || this.connsFor(c.id).length > 0),
    );
  }

  searchSummary() {
    const lines = [`Searching the local network as "${this.name}" on ${this.host} (${this.myAddresses()}).`];
    const found = this.visibleCandidates();
    for (const c of found) c.shown = true;
    const mismatched = [...this.mismatches.values()].filter((m) => Date.now() - m.seenAt < CANDIDATE_TTL_MS);
    for (const m of mismatched) {
      m.shown = true;
      lines.push(`Version problem: ${this.mismatchText(m)}`);
    }
    if (found.length === 0) {
      lines.push(
        'No other session found yet. This session keeps searching for 30 minutes. ' +
          `Ask the teammate to start ${START_HINT} on their machine (same Wi-Fi or LAN), then call multiplayer_join again. ` +
          `If discovery fails, the teammate can call multiplayer_join with address "${lanInterfaces()[0]?.address ?? 'this-ip'}:${this.port ?? TCP_PORT}".`,
      );
    } else {
      lines.push(`Found ${found.length} session${found.length > 1 ? 's' : ''}:`);
      for (const c of found) {
        const extra = c.peerAccepted ? ` (${c.name} already accepted)` : c.accepted ? ' (you accepted; waiting for them)' : '';
        lines.push(`- peer_id: ${c.id}  name: ${c.name}  host: ${c.host}  ip: ${c.ip}  agent: ${agentLabel(c.agent)}  code: ${c.code}${extra}`);
      }
      lines.push('Next: ask your user to check that the teammate\'s screen shows the same code, then call multiplayer_pair with that peer_id.');
    }
    const errs = Object.entries(this.errors).filter(([, v]) => v);
    if (this.udpSenders.length === 0) {
      errs.push(['network', 'no LAN interface is up; connect to Wi-Fi or Ethernet']);
    } else if (this.udpSenders.every((u) => u.mpError)) {
      errs.push(['udp_send', this.udpSenders.map((u) => u.mpError).join('; ')]);
    }
    if (errs.length) {
      for (const [k, v] of errs) lines.push(`Network problem (${k}): ${v}.${hint(v)}`);
    }
    if (this.delivery === 'pull') {
      lines.push('This session uses pull delivery: notices and teammate messages wait until you call a multiplayer tool. To wait for the teammate, call multiplayer_join again.');
    }
    return lines.join('\n');
  }

  liveSummary() {
    const lines = [
      `Teammate: ${agentOf(this.peer)} on ${this.peer.host} (code ${this.peer.code}).`,
      `Shared folder (live two-way sync with ${this.peer.name}'s machine): ${this.sharedDir}`,
      `Coordination board: ${path.join(this.sharedDir, 'NOTES.md')}`,
      'Use multiplayer_message for anything the teammate must know soon. Their messages arrive in this session tagged [multiplayer].',
    ];
    if (this.delivery === 'pull') {
      lines.push('This session uses pull delivery: teammate messages are added to the end of multiplayer tool results. Call multiplayer_inbox between steps of your work, and before you edit a shared file.');
    }
    if (this.peer.delivery === 'pull') {
      lines.push(`${agentOf(this.peer)} uses pull delivery: your messages wait until it next calls a multiplayer tool, so a steer cannot interrupt it.`);
    }
    return lines.join('\n');
  }

  record(dir, text, delivery) {
    this.history.push({ dir, text, delivery, at: Date.now() });
    if (this.history.length > 100) this.history.splice(0, this.history.length - 100);
  }

  /** Posts a notice from this server into this agent session. */
  notify(text, priority = 'later') {
    this.record('notice', text, priority === 'next' ? 'steer' : 'fyi');
    this.deliver(`[multiplayer] ${text}`, { from: 'multiplayer', priority });
  }

  /**
   * Pushes content into the session when it has an inbox socket. Otherwise,
   * or when the push fails, queues it for the next multiplayer tool result.
   */
  async deliver(content, opts) {
    if (this.inbox) {
      const r = await deliverToClaude(this.inbox, content, opts);
      if (r.ok) return { ok: true };
      this.log(`push failed, queued instead: ${r.error}`);
    }
    this.pending.push(content);
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    for (const wake of this.inboxWaiters) wake();
    return { ok: true, queued: true };
  }

  /** Removes and formats the queued messages and notices; '' when there are none. */
  takePending() {
    if (this.pending.length === 0) return '';
    const items = this.pending.splice(0);
    return [
      `--- ${items.length} teammate message${items.length > 1 ? 's' : ''} and notice${items.length > 1 ? 's' : ''}, oldest first. Handle them like messages that arrive on their own. ---`,
      ...items,
    ].join('\n\n');
  }

  /** multiplayer_inbox: returns queued messages, waiting up to wait_seconds for one. */
  async checkInbox({ wait_seconds } = {}) {
    const waitMs = Math.max(0, Math.min(110, Number(wait_seconds ?? 0))) * 1000;
    if (this.pending.length === 0 && waitMs > 0) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.inboxWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        this.inboxWaiters.add(done);
      });
    }
    return { text: this.takePending() || 'No new teammate messages.' };
  }

  // ------------------------------------------------------------- discovery

  beacon() {
    return {
      p: PROTO, v: PROTO_VERSION, ver: PLUGIN_VERSION, id: this.id, name: this.name, host: this.host, port: this.port,
      pub: this.identity.pub, agent: this.agent, delivery: this.delivery,
    };
  }

  /** Says which side must update when a session speaks another protocol version. */
  mismatchText(m) {
    const theirs = `${m.name} on ${m.host} runs Claude Multiplayer ${m.ver} (protocol ${m.v})`;
    const ours = `this session runs ${PLUGIN_VERSION} (protocol ${PROTO_VERSION})`;
    const who = m.v < PROTO_VERSION ? `${m.name} must update` : 'your user must update';
    return `${theirs}, but ${ours}, so the two cannot pair. ${who}: update the multiplayer plugin (in Claude Code, run \`${UPDATE_COMMAND}\` in a terminal), start a new session, then start ${START_HINT} again.`;
  }

  /** Records a session that speaks another protocol version, and tells the agent once. */
  onMismatch(b) {
    if (typeof b.id !== 'string' || !ID_RE.test(b.id) || b.id === this.id) return;
    let m = this.mismatches.get(b.id);
    if (!m) {
      m = { id: b.id, shown: false, notified: false };
      this.mismatches.set(b.id, m);
    }
    m.v = Number.isInteger(b.v) ? b.v : 0;
    m.ver = String(b.ver ?? 'an older version').replace(/[^\w.+-]/g, '').slice(0, 32) || 'an older version';
    m.name = cleanName(b.name);
    m.host = String(b.host ?? '').replace(/[^\w.-]/g, '').slice(0, 64) || 'unknown';
    m.seenAt = Date.now();
    if (m.notified || this.state !== 'searching') return;
    m.notified = true;
    setTimeout(() => {
      if (m.shown || this.state !== 'searching' || this.inFlight > 0) return;
      this.notify(`Found a session, but it cannot pair: ${this.mismatchText(m)} Tell your user.`, 'next');
    }, FOUND_NOTICE_DELAY_MS).unref?.();
  }

  /**
   * Tells this agent about a new session while no multiplayer_join call is
   * waiting, so the agent does not have to poll for the teammate.
   */
  noticeFound(c) {
    if (c.foundNotified || this.state !== 'searching') return;
    c.foundNotified = true;
    setTimeout(() => {
      if (c.shown || c.accepted || c.rejected || c.peerRejected || this.state !== 'searching' || this.inFlight > 0) return;
      if (!this.visibleCandidates().includes(c)) return;
      c.shown = true;
      this.notify(
        `${c.name} on ${c.host} is looking for a teammate too. Their screen shows code ${c.code}. ` +
          `Ask your user to check that the codes match. If they match, call multiplayer_pair with peer_id "${c.id}" and accept true; if not, call it with accept false.`,
        'next',
      );
    }, FOUND_NOTICE_DELAY_MS).unref?.();
  }

  startSearch() {
    if (this.state === 'left') this.resetPeer();
    if (this.state === 'idle' || this.state === 'left') this.state = 'searching';
    if (this.state === 'disconnected') this.reconnectUntil = Date.now() + RECONNECT_MAX_MS;
    this.searchUntil = Date.now() + SEARCH_MAX_MS;
    this.ensureUdp();
    if (!this.beaconTimer) {
      this.beaconTimer = setInterval(() => this.beaconTick(), BEACON_MS);
      this.beaconTimer.unref?.();
    }
    this.beaconTick();
  }

  stopSearch() {
    clearInterval(this.beaconTimer);
    this.beaconTimer = null;
    for (const s of this.udpSenders) {
      try {
        s.close();
      } catch {}
    }
    this.udpSenders = [];
    this.udpSig = '';
    if (this.udpListener) {
      try {
        this.udpListener.close();
      } catch {}
      this.udpListener = null;
    }
    this.removeRegistry();
  }

  beaconTick() {
    const active = (this.state === 'searching' && Date.now() < this.searchUntil) || this.state === 'disconnected';
    if (!active) {
      if (this.state === 'searching') this.stopSearch();
      return;
    }
    if (this.state === 'disconnected' && Date.now() > this.reconnectUntil) {
      this.stopSearch();
      return;
    }
    this.ensureUdp();
    const msg = Buffer.from(JSON.stringify(this.beacon()));
    for (const s of this.udpSenders) {
      const done = (err) => {
        s.mpError = err ? `${err.code || err.message} on ${s.mpAddress}` : null;
      };
      try {
        s.send(msg, DISCOVERY_PORT, MCAST_GROUP, done);
        if (!s.mpPointToPoint) s.send(msg, DISCOVERY_PORT, s.mpBroadcast, done);
      } catch (err) {
        done(err);
      }
    }
    if (this.state === 'disconnected') this.reconnectTick();
    this.writeRegistry();
    this.readRegistry();
  }

  ensureUdp() {
    if (!this.udpListener) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.on('error', (err) => {
        this.errors.udp_listen = err.code || err.message;
        this.log(`udp listen error: ${err.message}`);
        try {
          s.close();
        } catch {}
        if (this.udpListener === s) this.udpListener = null;
      });
      s.on('message', (buf, rinfo) => this.onBeacon(buf, rinfo.address, 'lan'));
      s.bind(DISCOVERY_PORT, () => {
        delete this.errors.udp_listen;
        for (const iface of lanInterfaces()) {
          try {
            s.addMembership(MCAST_GROUP, iface.address);
          } catch {}
        }
      });
      this.udpListener = s;
    }
    const ifaces = lanInterfaces();
    const sig = ifaces.map((i) => `${i.address}/${i.broadcast}`).join(',');
    if (sig === this.udpSig) return;
    for (const old of this.udpSenders) {
      try {
        old.close();
      } catch {}
    }
    this.udpSenders = [];
    this.udpSig = sig;
    for (const iface of ifaces) {
      const s = dgram.createSocket({ type: 'udp4' });
      s.mpAddress = iface.address;
      s.mpBroadcast = iface.broadcast;
      s.mpPointToPoint = iface.pointToPoint;
      s.mpError = null;
      s.on('error', (err) => {
        s.mpError = `${err.code || err.message} on ${iface.address}`;
      });
      s.bind({ address: iface.address, port: 0 }, () => {
        try {
          s.setBroadcast(true);
          s.setMulticastTTL(1);
          s.setMulticastLoopback(true);
          s.setMulticastInterface(iface.address);
        } catch {}
      });
      this.udpSenders.push(s);
    }
  }

  /** Same-machine discovery: sessions on one computer also find each other through files. */
  writeRegistry() {
    if (process.env.MULTIPLAYER_NO_REGISTRY === '1' || !this.port) return;
    try {
      fs.mkdirSync(this.beaconDir, { recursive: true, mode: 0o700 });
      const file = path.join(this.beaconDir, `${this.id}.json`);
      fs.writeFileSync(file + '.tmp', JSON.stringify({ ...this.beacon(), pid: process.pid }), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } catch {}
  }

  readRegistry() {
    if (process.env.MULTIPLAYER_NO_REGISTRY === '1') return;
    let names;
    try {
      names = fs.readdirSync(this.beaconDir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!/^[0-9a-f]{12}\.json$/.test(n) || n === `${this.id}.json`) continue;
      const file = path.join(this.beaconDir, n);
      try {
        const st = fs.statSync(file);
        const b = JSON.parse(fs.readFileSync(file, 'utf8'));
        let alive = true;
        try {
          process.kill(b.pid, 0);
        } catch (err) {
          alive = err.code === 'EPERM';
        }
        if (!alive || Date.now() - st.mtimeMs > 60_000) {
          fs.rmSync(file, { force: true });
          continue;
        }
        if (Date.now() - st.mtimeMs < CANDIDATE_TTL_MS) this.onBeacon(Buffer.from(JSON.stringify(b)), '127.0.0.1', 'local');
      } catch {}
    }
  }

  removeRegistry() {
    try {
      fs.rmSync(path.join(this.beaconDir, `${this.id}.json`), { force: true });
    } catch {}
  }

  onBeacon(buf, ip, source) {
    let b;
    try {
      b = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (b?.p === PROTO && b.v !== PROTO_VERSION) {
      this.onMismatch(b);
      return;
    }
    if (!this.validPeerInfo(b) || b.id === this.id) return;
    const c = this.upsertCandidate(b, ip, source);
    if (!c) return;
    c.seenAt = Date.now();
    this.noticeFound(c);
  }

  validPeerInfo(b) {
    return (
      b && b.p === PROTO && b.v === PROTO_VERSION && typeof b.id === 'string' && ID_RE.test(b.id) &&
      typeof b.pub === 'string' && b.pub.length < 200 && Number.isInteger(b.port) && b.port > 0 && b.port < 65536
    );
  }

  /** Adds or refreshes a candidate. Returns null when the info conflicts with a trusted peer. */
  upsertCandidate(b, ip, source) {
    let c = this.candidates.get(b.id);
    if (c && c.pub !== b.pub) {
      if (this.peer?.id === b.id) return null; // never let a beacon replace the key of the paired peer
      this.candidates.delete(b.id);
      c = null;
    }
    if (!c) {
      let derived;
      try {
        derived = derivePair(this.identity.privateKey, b.pub, this.id, b.id);
      } catch {
        return null;
      }
      c = {
        id: b.id, pub: b.pub, ...derived, seenAt: 0, addrs: new Map(), dialIndex: 0,
        accepted: false, peerAccepted: false, rejected: false, peerRejected: false, notified: false,
      };
      this.candidates.set(b.id, c);
    }
    c.name = cleanName(b.name);
    c.host = String(b.host ?? '').replace(/[^\w.-]/g, '').slice(0, 64) || 'unknown';
    // Versions before 0.3.0 send neither field, and they all run in Claude Code with push delivery.
    c.agent = cleanAgent(b.agent) || 'claude-code';
    c.delivery = b.delivery === 'pull' ? 'pull' : 'push';
    // Prefer a LAN address over loopback when a session is seen both ways.
    if (!c.ip || source !== 'local' || c.source === 'local') {
      c.ip = ip;
      c.port = b.port;
      c.source = source;
    }
    c.addrs.set(ip, Date.now());
    return c;
  }

  /** Dials a candidate, rotating through every address it was seen on recently. */
  dialCandidate(c) {
    const now = Date.now();
    const recent = [...c.addrs].filter(([, t]) => now - t < 30_000).map(([ip]) => ip);
    const ips = recent.length ? recent : [c.ip];
    const ip = ips[c.dialIndex++ % ips.length];
    this.dial(ip, c.port, c.id);
  }

  // ------------------------------------------------------------- the link

  ensureTcp() {
    if (this.tcpReady) return this.tcpReady;
    this.tcp = net.createServer((sock) => this.attach(sock, false, null));
    this.tcpReady = new Promise((resolve) => {
      const listen = (port) => {
        const onError = (err) => {
          if (port !== 0 && err.code === 'EADDRINUSE') return listen(0);
          this.errors.tcp = err.code || err.message;
          resolve();
        };
        this.tcp.once('error', onError);
        this.tcp.listen(port, '0.0.0.0', () => {
          this.tcp.off('error', onError);
          this.tcp.on('error', (err) => this.log(`tcp error: ${err.message}`));
          this.port = this.tcp.address().port;
          resolve();
        });
      };
      listen(TCP_PORT);
    });
    return this.tcpReady;
  }

  connsFor(peerId) {
    return [...this.conns].filter((k) => !k.sock.destroyed && (k.peerId === peerId || k.expectId === peerId));
  }

  /** Dials a peer's link port; at most one dial per peer is in progress. */
  dial(ip, port, expectId) {
    if (!ip || !port) return;
    const key = expectId || `${ip}:${port}`;
    if (this.dialing.has(key)) return;
    this.dialing.add(key);
    const sock = net.connect({ host: ip, port, timeout: 5000 });
    sock.once('close', () => this.dialing.delete(key));
    sock.once('connect', () => {
      this.dialing.delete(key);
      delete this.errors.dial;
      sock.setTimeout(0);
      this.attach(sock, true, expectId);
    });
    sock.once('timeout', () => sock.destroy());
    sock.once('error', (err) => {
      this.errors.dial = `${err.code || err.message} to ${ip}:${port}`;
      this.log(`dial ${ip}:${port} failed: ${err.message}`);
    });
  }

  dialAddress(address) {
    const m = /^\s*([0-9.]+|[A-Za-z0-9.-]+)(?::(\d+))?\s*$/.exec(address);
    if (!m) {
      this.errors.address = `cannot read "${address}"; use ip or ip:port`;
      return;
    }
    this.dial(m[1], Number(m[2] || TCP_PORT), null);
  }

  /** Opens or reuses a link to an accepted candidate and sends our accept. */
  connectAccepted(c) {
    const existing = this.connsFor(c.id).find((k) => k.peerId === c.id);
    if (existing) {
      if (!existing.sentAccept) this.sendAccept(existing);
    } else if (this.connsFor(c.id).length === 0) {
      this.dialCandidate(c);
    }
  }

  attach(sock, initiator, expectId) {
    const conn = {
      sock,
      initiator,
      expectId,
      peerId: null,
      key: null,
      myNonce: crypto.randomBytes(12).toString('base64'),
      peerNonce: null,
      seqOut: 0,
      seqIn: 0,
      sentAccept: false,
      gotAccept: false,
      live: false,
      openedAt: Date.now(),
      lastData: Date.now(),
      buf: '',
      decoder: new StringDecoder('utf8'),
    };
    this.conns.add(conn);
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10_000);
    sock.on('data', (chunk) => {
      conn.lastData = Date.now();
      const start = conn.buf.length;
      conn.buf += conn.decoder.write(chunk);
      if (conn.buf.length > MAX_LINE_CHARS) {
        sock.destroy();
        return;
      }
      let from = 0;
      let nl = conn.buf.indexOf('\n', start);
      while (nl >= 0) {
        const line = conn.buf.slice(from, nl);
        from = nl + 1;
        if (line) this.onLine(conn, line);
        if (sock.destroyed) return;
        nl = conn.buf.indexOf('\n', from);
      }
      if (from > 0) conn.buf = conn.buf.slice(from);
    });
    sock.on('error', (err) => this.log(`link error: ${err.message}`));
    sock.on('close', () => this.onClose(conn));
    setTimeout(() => {
      if (!conn.live && !sock.destroyed) sock.destroy();
    }, PENDING_CONN_MAX_MS).unref?.();
    this.sendPlain(conn, {
      t: 'hello', p: PROTO, v: PROTO_VERSION, ver: PLUGIN_VERSION, id: this.id, name: this.name, host: this.host,
      port: this.port, pub: this.identity.pub, nonce: conn.myNonce, agent: this.agent, delivery: this.delivery,
    });
  }

  sendPlain(conn, obj) {
    if (conn.sock.destroyed) return false;
    return conn.sock.write(JSON.stringify(obj) + '\n');
  }

  /** Encrypts and queues one frame. Returns false only when the link cannot take it. */
  sendSealed(conn, obj) {
    if (!conn || conn.sock.destroyed || !conn.key) return false;
    conn.seqOut++;
    conn.sock.write(JSON.stringify(seal(conn.key, { ...obj, s: conn.seqOut, c: conn.peerNonce })) + '\n');
    return true;
  }

  onLine(conn, line) {
    let f;
    try {
      f = JSON.parse(line);
    } catch {
      conn.sock.destroy();
      return;
    }
    if (!conn.peerId) {
      if (f.t !== 'hello') {
        conn.sock.destroy();
        return;
      }
      this.onHello(conn, f);
      return;
    }
    if (f.t === 'dup' || f.t === 'busy') {
      if (f.t === 'busy') this.errors.pair = `${this.candidates.get(conn.peerId)?.name ?? 'that session'} is already paired with someone else`;
      conn.sock.destroy();
      return;
    }
    if (f.t !== 'e') return;
    let m;
    try {
      m = open(conn.key, f);
    } catch {
      conn.sock.destroy();
      return;
    }
    if (m.c !== conn.myNonce || !(m.s > conn.seqIn)) {
      conn.sock.destroy();
      return;
    }
    conn.seqIn = m.s;
    this.onFrame(conn, m);
  }

  onHello(conn, f) {
    const info = { ...f };
    if (info.p === PROTO && info.v !== PROTO_VERSION) {
      this.onMismatch(info);
      conn.sock.destroy();
      return;
    }
    if (!this.validPeerInfo(info) || info.id === this.id || typeof info.nonce !== 'string') {
      conn.sock.destroy();
      return;
    }
    if (conn.expectId && info.id !== conn.expectId) {
      conn.sock.destroy();
      return;
    }
    const remoteIp = String(conn.sock.remoteAddress || '').replace(/^::ffff:/, '');
    const known = this.candidates.get(info.id);
    const c = this.upsertCandidate(info, known?.ip ?? remoteIp, known?.source ?? 'inbound');
    if (!c) {
      conn.sock.destroy();
      return;
    }
    if (!known && remoteIp) c.ip = remoteIp;
    c.seenAt = Date.now();
    this.noticeFound(c);

    if (this.state === 'live' && this.peer && this.peer.id !== c.id) {
      this.sendPlain(conn, { t: 'busy' });
      conn.sock.end();
      return;
    }

    // Keep one link per peer: the live one, else the one dialed by the smaller id.
    const dialerOf = (k) => (k.initiator ? this.id : k.peerId ?? k.expectId);
    conn.peerId = c.id;
    for (const other of this.connsFor(c.id)) {
      if (other === conn) continue;
      const keepOther = other.live || dialerOf(other) < dialerOf(conn) || (dialerOf(other) === dialerOf(conn) && other.openedAt > conn.openedAt);
      if (keepOther) {
        this.sendPlain(conn, { t: 'dup' });
        conn.sock.end();
        return;
      }
      this.sendPlain(other, { t: 'dup' });
      other.sock.end();
    }

    conn.key = c.key;
    conn.peerNonce = info.nonce;
    if (c.rejected) {
      this.sendSealed(conn, { t: 'reject' });
      conn.sock.end();
      return;
    }
    if (c.accepted) this.sendAccept(conn);
  }

  sendAccept(conn) {
    if (conn.sentAccept) return;
    if (this.sendSealed(conn, { t: 'accept', name: this.name })) conn.sentAccept = true;
    this.checkLive(conn);
  }

  onFrame(conn, m) {
    const c = this.candidates.get(conn.peerId);
    if (!c) return;
    switch (m.t) {
      case 'accept':
        conn.gotAccept = true;
        c.peerAccepted = true;
        if (c.accepted) this.sendAccept(conn);
        else this.noticePeerAccepted(c);
        this.checkLive(conn);
        break;
      case 'reject':
        c.peerRejected = true;
        conn.sock.end();
        break;
      case 'msg':
        if (conn.live) this.onPeerMessage(conn, m);
        break;
      case 'rcpt': {
        const resolve = this.pendingReceipts.get(m.id);
        if (resolve) resolve({ ok: m.ok === true, queued: m.queued === true, error: String(m.error ?? '') });
        break;
      }
      case 'bye':
        conn.peerSaidBye = true;
        conn.sock.end();
        break;
      case 'manifest':
      case 'file':
      case 'del':
        if (conn.live && this.sync) this.sync.handle(m);
        break;
      default:
        break;
    }
  }

  /**
   * Nudges this agent when the peer accepted first. Waits a little, because
   * the local user is usually comparing codes at that moment anyway.
   */
  noticePeerAccepted(c) {
    if (c.notified) return;
    c.notified = true;
    setTimeout(() => {
      if (c.accepted || c.rejected || this.state === 'live' || this.inFlight > 0) return;
      this.notify(
        `${c.name} on ${c.host} accepted pairing with this session. Their screen shows code ${c.code}. ` +
          `Ask your user to check that the codes match. If they match, call multiplayer_pair with peer_id "${c.id}" and accept true; if not, call it with accept false.`,
        'next',
      );
    }, ACCEPT_NOTICE_DELAY_MS).unref?.();
  }

  checkLive(conn) {
    if (conn.live || !conn.sentAccept || !conn.gotAccept || conn.sock.destroyed) return;
    conn.live = true;
    this.goLive(conn);
  }

  goLive(conn) {
    const c = this.candidates.get(conn.peerId);
    const reconnect = this.peer?.id === c.id;
    this.peer = c;
    this.liveConn = conn;
    this.state = 'live';
    this.stopSearch();
    for (const other of [...this.conns]) {
      if (other !== conn && other.peerId !== c.id) {
        this.sendPlain(other, { t: 'busy' });
        other.sock.end();
      }
    }
    if (!this.sharedDir) {
      const [first, second] = this.id < c.id ? [this.name, c.name] : [c.name, this.name];
      this.sharedDir = this.sharedDirOverride || path.join(os.homedir(), 'claude-multiplayer', `${slug(first)}-${slug(second)}-${c.room}`);
    }
    if (!this.sync) {
      try {
        this.sync = new FolderSync({
          root: this.sharedDir,
          tieWinner: this.id < c.id,
          send: (frame) => this.sendSealed(this.liveConn, frame),
          log: (m) => this.log(m),
        });
        if (this.id < c.id) this.seedNotes(c);
      } catch (err) {
        this.errors.shared_dir = `${this.sharedDir}: ${err.message}`;
      }
    }
    this.sync?.connected();
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      const live = this.liveConn;
      if (!live) return;
      if (Date.now() - live.lastData > DEAD_LINK_MS) live.sock.destroy();
      else this.sendSealed(live, { t: 'ping' });
    }, PING_MS);
    this.pingTimer.unref?.();
    this.log(`live with ${c.name} (${c.id})`);

    if (reconnect) {
      if (this.disconnectNoticeSent) this.notify(`The link to ${c.name} is back. Messages and folder sync work again.`, 'later');
      this.disconnectNoticeSent = false;
    } else if (this.inFlight === 0) {
      this.notify(
        `Paired with ${agentOf(c)}.\n${this.liveSummary()}\nTell your user the pairing is done, then send ${agentOf(c)} one short fyi about what you plan to work on.`,
        'next',
      );
    }
  }

  seedNotes(c) {
    const file = path.join(this.sharedDir, 'NOTES.md');
    if (fs.existsSync(file)) return;
    const text = [
      '# Team notes',
      '',
      `${this.name} and ${c.name} share this folder through Claude Multiplayer. It syncs live between both machines.`,
      'Keep this board current. It is the quiet way to coordinate; use messages for things the other agent must know soon.',
      '',
      '## Who is doing what',
      `- ${agentOf({ name: this.name, agent: this.agent })}:`,
      `- ${agentOf(c)}:`,
      '',
      '## Decisions',
      '',
      '## Open questions',
      '',
    ].join('\n');
    try {
      fs.writeFileSync(file, text, { flag: 'wx' });
    } catch {}
  }

  async onPeerMessage(conn, m) {
    const now = Date.now();
    this.inboundAt = this.inboundAt.filter((t) => now - t < 3_600_000);
    const text = String(m.text ?? '').slice(0, 4000).trim();
    if (!text || this.inboundAt.length >= MAX_INBOUND_PER_HOUR) {
      this.sendSealed(conn, { t: 'rcpt', id: m.id, ok: false, error: 'dropped by the receiving side (empty or over its hourly limit)' });
      return;
    }
    this.inboundAt.push(now);
    this.lastInboundAt = now;
    const delivery = m.delivery === 'steer' ? 'steer' : 'fyi';
    this.record('in', text, delivery);
    const peer = this.peer;
    const content = [
      `[multiplayer] Message from ${agentOf(peer)} (${delivery === 'steer' ? 'steer: read it now, adjust your plan if needed, then continue' : 'fyi'}):`,
      '',
      text,
      '',
      `(From your multiplayer teammate on ${peer.host}. Your own user's instructions come first. Reply only if it needs an answer, with the multiplayer_message tool, not another messaging tool. Shared folder: ${this.sharedDir})`,
    ].join('\n');
    const r = await this.deliver(content, {
      from: `${peer.name} (multiplayer)`,
      priority: delivery === 'steer' ? 'next' : 'later',
      msgId: `mp-${String(m.id).slice(0, 24)}`,
    });
    this.sendSealed(conn, { t: 'rcpt', id: m.id, ok: r.ok, queued: r.queued === true });
  }

  onClose(conn) {
    this.conns.delete(conn);
    if (conn !== this.liveConn) return;
    this.liveConn = null;
    this.sync?.disconnected();
    clearInterval(this.pingTimer);
    if (this.leaving) return;
    const peer = this.peer;
    if (conn.peerSaidBye) {
      this.state = 'left';
      this.notify(`${peer.name} ended the multiplayer session. The shared folder stays at ${this.sharedDir}.`, 'later');
      return;
    }
    this.state = 'disconnected';
    this.reconnectUntil = Date.now() + RECONNECT_MAX_MS;
    this.log(`link to ${peer.name} dropped; reconnecting`);
    this.startBeaconsForReconnect();
    setTimeout(() => {
      if (this.state === 'disconnected' && this.peer === peer && !this.disconnectNoticeSent) {
        this.disconnectNoticeSent = true;
        this.notify(`The link to ${peer.name} dropped. This session retries for 10 minutes. Keep working; shared files sync again after it reconnects.`, 'later');
      }
    }, 20_000).unref?.();
  }

  startBeaconsForReconnect() {
    this.ensureUdp();
    if (!this.beaconTimer) {
      this.beaconTimer = setInterval(() => this.beaconTick(), BEACON_MS);
      this.beaconTimer.unref?.();
    }
  }

  reconnectTick() {
    const c = this.peer;
    if (!c || this.connsFor(c.id).length > 0) return;
    this.dialCandidate(c);
  }
}
