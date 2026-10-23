// MCP stdio server for Multiplayer. The agent (Claude Code, Codex or any
// MCP client) starts one per session. It stays idle (no network use) until the
// user starts the multiplayer skill and the agent calls multiplayer_join. Stdout carries only JSON-RPC; logs go to
// ~/.claude-multiplayer/logs/.
import readline from 'node:readline';
import { Multiplayer, LIMITS, PLUGIN_VERSION } from './multiplayer.mjs';

const mp = new Multiplayer();

const INSTRUCTIONS =
  'Multiplayer pairs this session with a teammate\'s coding agent session (Claude Code, Codex or another MCP client) on the same local network. ' +
  'It does nothing until the user starts the multiplayer skill. Messages from the teammate start with [multiplayer]; ' +
  'answer them with multiplayer_message, never another messaging tool.' +
  (mp.delivery === 'pull'
    ? ' Teammate messages are not pushed into this session: they are added to the end of multiplayer tool results, and multiplayer_inbox checks for new ones.'
    : '');

const TOOLS = [
  {
    name: 'multiplayer_join',
    description:
      'Start looking for a teammate\'s agent session (Claude Code, Codex or another agent) on this local network. The multiplayer skill drives this. ' +
      'Waits up to wait_seconds for other sessions that are also looking, then lists each one with a peer_id and a 6-digit pairing code. ' +
      'Searching continues in the background after the call returns, so call it again to keep waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name to show the teammate, normally your user\'s first name. Defaults to the git user name.' },
        shared_dir: { type: 'string', description: 'Absolute path for the shared folder on this machine. Default: ~/multiplayer/<pair-name>.' },
        address: { type: 'string', description: 'Teammate address as "ip" or "ip:port", only when automatic discovery fails.' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 110, description: 'How long to wait for a session to appear. Default 40.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'multiplayer_pair',
    description:
      'Accept or decline a session that multiplayer_join found. Call it with accept=true only after your user confirmed that the teammate\'s screen shows the same 6-digit code. ' +
      'With accept=true it waits until the teammate accepts too, then returns the shared folder path. The pairing also completes on its own later if the teammate is slower.',
    inputSchema: {
      type: 'object',
      properties: {
        peer_id: { type: 'string', description: 'peer_id from multiplayer_join.' },
        accept: { type: 'boolean', description: 'true to pair, false to decline.' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 110, description: 'How long to wait for the teammate to accept. Default 90.' },
      },
      required: ['peer_id', 'accept'],
      additionalProperties: false,
    },
  },
  {
    name: 'multiplayer_message',
    description:
      'Send a short message to your paired teammate\'s agent. It lands in their session like a coworker tapping them on the shoulder, so use it the way a good engineer messages one close teammate. ' +
      'Send one when you: claim a piece of shared work before you start it; finish or hand off something they depend on; change a shared interface, file layout or plan; hit a blocker or need a decision only they can make; or find something that changes their work. ' +
      'Be self-sufficient first: look things up and decide on your own when you can. Do not send acknowledgements, thanks, "on it", step-by-step progress or chat, and do not reply just to confirm. Put several points in one message. ' +
      'delivery "steer" reaches them after their current tool call, in the middle of their turn; use it only when they should change course now. delivery "fyi" waits until their current turn ends. ' +
      'If their agent uses pull delivery, both wait until it next calls a multiplayer tool. ' +
      `Limits: ${LIMITS.maxChars} characters; one steer per ${LIMITS.steerGapMs / 1000}s; ${LIMITS.perHour} messages per hour; a reply to a message they just sent is always allowed. ` +
      'For long content, write a file in the shared folder and send its path. Use NOTES.md in the shared folder for status that does not need their attention now.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message. Plain, specific, self-contained. Name files and paths.' },
        delivery: { type: 'string', enum: ['steer', 'fyi'], description: '"steer" interrupts their current turn; "fyi" waits until it ends.' },
      },
      required: ['text', 'delivery'],
      additionalProperties: false,
    },
  },
  {
    name: 'multiplayer_inbox',
    description:
      'Check for teammate messages and multiplayer notices that are waiting for this session. ' +
      'Every multiplayer tool result already ends with any waiting messages; this tool is for checking between steps when the session uses pull delivery, ' +
      'or for waiting up to wait_seconds for the teammate to answer. While it waits, a new teammate message comes straight back as its result, with push or pull delivery.',
    inputSchema: {
      type: 'object',
      properties: {
        wait_seconds: { type: 'integer', minimum: 0, maximum: 110, description: 'How long to wait when nothing is waiting yet. Default 0.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'multiplayer_status',
    description: 'Show the pairing state, the teammate, the shared folder, sync counts, the message limits and the recent message log.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'multiplayer_leave',
    description: 'End the multiplayer session and stop folder sync. The shared folder stays on disk. Use it only when your user wants to stop.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const HANDLERS = {
  multiplayer_join: (a) => mp.join(a),
  multiplayer_pair: (a) => mp.pair(a),
  multiplayer_message: (a) => mp.message(a),
  multiplayer_inbox: (a) => mp.checkInbox(a),
  multiplayer_status: () => mp.status(),
  multiplayer_leave: () => mp.leave(),
};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handle(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (id === undefined || id === null) return; // notifications need no answer

  try {
    if (method === 'initialize') {
      mp.setClient(params?.clientInfo);
      mp.log(`initialize: client ${params?.clientInfo?.name} ${params?.clientInfo?.version}, agent ${mp.agent}, delivery ${mp.delivery}`);
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'multiplayer', version: PLUGIN_VERSION },
          instructions: INSTRUCTIONS,
        },
      });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const handler = HANDLERS[params?.name];
      if (!handler) {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
        return;
      }
      const out = await handler(params.arguments || {});
      // Pull delivery: queued teammate messages ride along on every tool result.
      const waiting = mp.takePending();
      const text = waiting ? `${out.text}\n\n${waiting}` : out.text;
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: out.error === true } });
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    mp.log(`handler error: ${err.stack || err.message}`);
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `multiplayer error: ${err.message}` }], isError: true } });
  }
}

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await mp.shutdown();
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  handle(line);
});
rl.on('close', close);
process.on('SIGTERM', close);
process.on('SIGINT', close);
process.on('uncaughtException', (err) => mp.log(`uncaught: ${err.stack || err.message}`));
process.on('unhandledRejection', (err) => mp.log(`unhandled: ${err?.stack || err}`));
