// A stdio MCP server that serves read-tools.ts. The agent starts it; it is the
// agent's only way to see the repository.
//
//   NHR_ROOT=<repo> NHR_READ_LOG=<file> node read-tools-server.ts
//
// Every successful read is appended to NHR_READ_LOG as one JSON line
// ({"path","fromLine","toLine"}), before the result goes back to the agent.
// The adapter takes the proof of reading from that file. The agent cannot
// write to it: it has no shell and no write tool.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { callKey, callTool, ToolError, TOOL_DEFINITIONS } from './read-tools.ts';

const root = process.env.NHR_ROOT;
const log = process.env.NHR_READ_LOG;
if (!root || !log) {
  process.stderr.write('read-tools-server: NHR_ROOT and NHR_READ_LOG must be set\n');
  process.exit(2);
}

type Id = string | number | null;
const send = (msg: object): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
};
const reply = (id: Id, result: object): void => send({ id, result });
const fail = (id: Id, code: number, message: string): void => send({ id, error: { code, message } });

function handle(msg: { id?: Id; method?: string; params?: Record<string, unknown> }): void {
  const id = msg.id ?? null;
  const isRequest = msg.id !== undefined;
  switch (msg.method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'needs-human-review-read-tools', version: '1.0.0' },
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOL_DEFINITIONS });
    case 'tools/call': {
      const name = typeof msg.params?.name === 'string' ? msg.params.name : '';
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const r = callTool(root as string, name, args);
        // Logged before the reply: a read the agent got is always in the log.
        // The call's own arguments go along, so the adapter can match the entry to a completed call in the agent's log.
        if (r.read) appendFileSync(log as string, `${JSON.stringify({ ...r.read, call: callKey(args) })}\n`);
        return reply(id, { content: [{ type: 'text', text: r.text }] });
      } catch (e) {
        const message = e instanceof ToolError ? e.message : `tool failed: ${(e as Error).message}`;
        return reply(id, { content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default:
      // Notifications (no id) need no answer.
      if (isRequest) fail(id, -32601, `method not found: ${msg.method}`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, -32700, 'parse error');
  }
  handle(msg);
});
