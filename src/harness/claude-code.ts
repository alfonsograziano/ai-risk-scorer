import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileRead } from '../types.ts';
import { agentEnv, relativePath, runProcess, timeoutMessage } from './process.ts';
import type { ClaudeProvider } from './settings.ts';
import { HarnessError, type Harness, type HarnessInput, type HarnessResult } from './types.ts';

/** The only tools the reviewer gets. All three only read. */
export const TOOLS = 'Read,Grep,Glob';
export const MAX_TURNS = 80;

/**
 * The arguments for one read-only, headless reviewer.
 *
 * - `--restricted` drops every tool that runs commands or reaches the web,
 *   ignores user, project and local settings files (so the PR cannot add a
 *   hook in `.claude/settings.json`) and keeps the file tools inside the workdir.
 * - `--tools` offers the model only Read, Grep and Glob; `--allowedTools` with
 *   `dontAsk` approves those and denies anything else instead of asking.
 * - `--strict-mcp-config` with no `--mcp-config` loads no MCP server, not even
 *   one from a `.mcp.json` in the PR. `--disable-slash-commands` turns off skills.
 * - The system prompt replaces Claude Code's own, read from a file so a long
 *   custom prompt does not hit the argument size limit.
 */
export function claudeArgs(input: { userMessage: string; model: string; systemPromptFile: string; effort?: string }): string[] {
  return [
    '--print',
    '--restricted',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--tools', TOOLS,
    '--allowedTools', TOOLS,
    '--permission-mode', 'dontAsk',
    '--system-prompt-file', input.systemPromptFile,
    '--model', input.model,
    ...(input.effort ? ['--effort', input.effort] : []),
    '--max-turns', String(MAX_TURNS),
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    // Everything after -- is the prompt, even if it starts with a dash.
    '--',
    input.userMessage,
  ];
}

/**
 * Claude Code reaches the model with an Anthropic key or OAuth token, or
 * through Bedrock, Vertex AI or Foundry with that cloud's own credentials.
 */
const CREDENTIALS = /^(ANTHROPIC_[A-Z0-9_]+|CLAUDE_CODE_(OAUTH_TOKEN|SKIP_[A-Z_]+_AUTH)|AWS_[A-Z0-9_]+|GOOGLE_[A-Z0-9_]+|GCLOUD_PROJECT|CLOUD_ML_REGION|VERTEX_REGION_[A-Z0-9_]+|AZURE_[A-Z0-9_]+)$/;

/** Where the model is and how to reach it, from the api-key input and the harness settings. */
export interface Connection {
  apiKey?: string;
  provider?: ClaudeProvider;
  baseUrl?: string;
  auth?: string;
  region?: string;
  project?: string;
}

/** Each provider's switch, base URL variable and the variables a key can travel in. */
const PROVIDERS: Record<ClaudeProvider, { use?: string; baseUrl: string; keys: string[] }> = {
  anthropic: { baseUrl: 'ANTHROPIC_BASE_URL', keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] },
  bedrock: { use: 'CLAUDE_CODE_USE_BEDROCK', baseUrl: 'ANTHROPIC_BEDROCK_BASE_URL', keys: ['AWS_BEARER_TOKEN_BEDROCK'] },
  vertex: { use: 'CLAUDE_CODE_USE_VERTEX', baseUrl: 'ANTHROPIC_VERTEX_BASE_URL', keys: [] },
  foundry: { use: 'CLAUDE_CODE_USE_FOUNDRY', baseUrl: 'ANTHROPIC_FOUNDRY_BASE_URL', keys: ['ANTHROPIC_FOUNDRY_API_KEY'] },
};

/**
 * The variable api-key goes in.
 *
 * - anthropic: x-api-key (ANTHROPIC_API_KEY) for Anthropic's API; a bearer
 *   token (ANTHROPIC_AUTH_TOKEN) for gateways such as OpenCode Console, the
 *   default once base-url is set; or oauth (CLAUDE_CODE_OAUTH_TOKEN), a Claude
 *   subscription token from `claude setup-token`.
 * - bedrock: a Bedrock API key (AWS_BEARER_TOKEN_BEDROCK). Without one, AWS credentials from the job env.
 * - foundry: a Foundry key (ANTHROPIC_FOUNDRY_API_KEY). Without one, Azure credentials from the job env.
 * - vertex: none. Google credentials only; the config check refuses api-key.
 */
export function keyVariable(conn: Connection): string | undefined {
  const provider = conn.provider ?? 'anthropic';
  if (provider !== 'anthropic') return PROVIDERS[provider].keys[0];
  const auth = conn.auth || (conn.baseUrl ? 'bearer' : 'x-api-key');
  return auth === 'bearer' ? 'ANTHROPIC_AUTH_TOKEN' : auth === 'oauth' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';
}

export function claudeEnv(source: Record<string, string | undefined>, configDir: string, conn: Connection = {}): Record<string, string> {
  const env = agentEnv(source, CREDENTIALS);
  const provider = conn.provider ?? 'anthropic';
  const spec = PROVIDERS[provider];
  // The provider setting decides where the model runs, not a CLAUDE_CODE_USE_* left in the job env.
  for (const p of Object.values(PROVIDERS)) if (p.use) delete env[p.use];
  if (spec.use) env[spec.use] = '1';
  if (conn.baseUrl) env[spec.baseUrl] = conn.baseUrl;
  if (provider === 'bedrock' && conn.region) env.AWS_REGION = conn.region;
  if (provider === 'vertex') {
    if (conn.region) env.CLOUD_ML_REGION = conn.region;
    // google-github-actions/auth sets GOOGLE_CLOUD_PROJECT; Claude Code reads ANTHROPIC_VERTEX_PROJECT_ID.
    const project = conn.project || env.ANTHROPIC_VERTEX_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT;
    if (project) env.ANTHROPIC_VERTEX_PROJECT_ID = project;
  }
  const variable = keyVariable(conn);
  if (conn.apiKey && variable) {
    // api-key is the one key: drop any other from the job env, so only it is sent, and only one way.
    for (const k of spec.keys) delete env[k];
    env[variable] = conn.apiKey;
  }
  return {
    ...env,
    // A fresh config folder: no user settings, plugins, memory or sessions from the runner.
    CLAUDE_CONFIG_DIR: configDir,
    // The repo is untrusted. A CLAUDE.md in the PR must not reach the model as instructions.
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    // No auto-update, telemetry or error reporting from CI.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  text?: string;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  message?: { content?: unknown };
  tool_use_result?: unknown;
  result?: unknown;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

function blocks(e: StreamEvent): ContentBlock[] {
  const c = e.message?.content;
  return Array.isArray(c) ? (c as ContentBlock[]) : [];
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
  return '';
}

/**
 * The line range one Read call returned, from the tool's own result, never
 * from what the model asked for. First the structured result Claude Code
 * attaches (`file.startLine`, `file.numLines`), then the line numbers in the
 * text it gave the model. If neither is there, the read does not count: the
 * check then fails and a human reviews the PR.
 */
export function readFromResult(workdir: string, toolInput: Record<string, unknown>, result: { content: unknown; structured?: unknown }): FileRead | undefined {
  const s = result.structured as { type?: string; file?: { filePath?: unknown; startLine?: unknown; numLines?: unknown } } | undefined;
  const asked = typeof toolInput.file_path === 'string' ? toolInput.file_path : undefined;
  const file = s?.file;
  if (s?.type === 'text' && file && typeof file.startLine === 'number' && typeof file.numLines === 'number') {
    const path = relativePath(workdir, typeof file.filePath === 'string' ? file.filePath : (asked ?? ''));
    if (path === '') return undefined;
    return { path, fromLine: file.startLine, toLine: file.startLine + file.numLines - 1 };
  }
  if (asked === undefined) return undefined;
  const path = relativePath(workdir, asked);
  const text = resultText(result.content);
  // Split on \n only. A multiline regex would also start a line after \r, U+2028
  // or U+2029, so a file holding "U+2028 2001→" could fake line numbers it never returned.
  const numbers = text
    .split('\n')
    .map((l) => /^ *(\d+)(?:\t|→)/.exec(l)?.[1])
    .filter((n) => n !== undefined)
    .map(Number);
  const first = numbers[0];
  if (first !== undefined) {
    // Only the unbroken run from the first number: a note after the content cannot stretch the range.
    let last = first;
    for (const n of numbers.slice(1)) {
      if (n !== last + 1) break;
      last = n;
    }
    return { path, fromLine: first, toLine: last };
  }
  if (/contents are empty|file is empty/i.test(text)) return { path, fromLine: 1, toLine: 0 };
  return undefined;
}

export interface ParsedStream {
  finalText: string;
  reads: FileRead[];
  costUsd: number;
  tokens: { input: number; output: number };
  /** Why the run failed, from the result event. Empty when it succeeded. */
  errors: string[];
  sawResult: boolean;
}

/** Parses `claude --print --output-format stream-json --verbose` output: one JSON event per line. */
export function parseStream(workdir: string, stdout: string): ParsedStream {
  const readCalls = new Map<string, Record<string, unknown>>();
  const reads: FileRead[] = [];
  const errors: string[] = [];
  const tokens = { input: 0, output: 0 };
  let finalText = '';
  let costUsd = 0;
  let sawResult = false;
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let e: StreamEvent;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'assistant') {
      for (const b of blocks(e)) if (b.type === 'tool_use' && b.name === 'Read' && b.id) readCalls.set(b.id, b.input ?? {});
    } else if (e.type === 'user') {
      const results = blocks(e).filter((b) => b.type === 'tool_result');
      for (const b of results) {
        const input = b.tool_use_id ? readCalls.get(b.tool_use_id) : undefined;
        if (!input || b.is_error) continue;
        // The structured result belongs to the message, so it is only safe to use when the message holds one result.
        const r = readFromResult(workdir, input, { content: b.content, ...(results.length === 1 ? { structured: e.tool_use_result } : {}) });
        if (r) reads.push(r);
      }
    } else if (e.type === 'result') {
      sawResult = true;
      costUsd = Number(e.total_cost_usd ?? 0);
      const u = e.usage ?? {};
      tokens.input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      tokens.output = u.output_tokens ?? 0;
      const text = typeof e.result === 'string' ? e.result : '';
      // A failed run can still say subtype "success", so is_error decides.
      if (e.is_error || e.subtype !== 'success') errors.push(`${e.subtype && e.subtype !== 'success' ? `${e.subtype}: ` : ''}${text || 'no message'}`.slice(0, 500));
      else finalText = text;
    }
  }
  return { finalText, reads, costUsd, tokens, errors, sawResult };
}

/**
 * The event log without what tools returned. Tool results are file content:
 * they stay on the runner. The record keeps which tools ran, on what, and the text.
 */
export function redactStream(stdout: string): string {
  return stdout
    .split('\n')
    .map((line) => {
      if (!line.trim().startsWith('{')) return line;
      try {
        const e = JSON.parse(line) as StreamEvent;
        if (e.type !== 'user') return line;
        delete e.tool_use_result;
        for (const b of blocks(e)) if (b.type === 'tool_result') b.content = '[removed]';
        return JSON.stringify(e);
      } catch {
        return '[unparsed line removed]';
      }
    })
    .join('\n');
}

export class ClaudeCodeHarness implements Harness {
  readonly name = 'claude-code';
  readonly #bin: string;
  readonly #effort: string | undefined;
  readonly #conn: Connection;

  constructor(settings: { effort?: string } & Connection = {}, bin = process.env.CLAUDE_BIN || 'claude') {
    this.#bin = bin;
    this.#effort = settings.effort;
    const { effort: _, ...conn } = settings;
    this.#conn = conn;
  }

  async run(input: HarnessInput): Promise<HarnessResult> {
    const started = Date.now();
    const configDir = await mkdtemp(join(tmpdir(), 'nhr-claude-'));
    try {
      const systemPromptFile = join(configDir, 'system-prompt.md');
      await writeFile(systemPromptFile, input.systemPrompt);
      const args = claudeArgs({ userMessage: input.userMessage, model: input.model, systemPromptFile, ...(this.#effort ? { effort: this.#effort } : {}) });
      const env = claudeEnv(process.env, configDir, this.#conn);
      const { code, stdout, stderr, timedOut } = await runProcess('claude', this.#bin, args, { cwd: input.workdir, env, timeoutMs: input.timeoutMs });

      const raw = redactStream(stdout);
      if (timedOut) throw new HarnessError(timeoutMessage(input.timeoutMs), raw);
      const parsed = parseStream(input.workdir, stdout);
      if (code !== 0) {
        const why = [...parsed.errors, stderr.trim().slice(-500)].filter((s) => s !== '').join('; ') || 'no error message';
        throw new HarnessError(`claude exited with code ${code}: ${why}`, raw);
      }
      if (!parsed.sawResult) throw new HarnessError('claude ended without a result event', raw);
      if (parsed.errors.length > 0) throw new HarnessError(`claude reported an error: ${parsed.errors.join('; ')}`, raw);
      if (parsed.finalText.trim() === '') throw new HarnessError('the model gave no final answer', raw);
      return {
        finalText: parsed.finalText,
        raw,
        durationMs: Date.now() - started,
        reads: parsed.reads,
        costUsd: parsed.costUsd,
        tokens: parsed.tokens,
      };
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  }
}
