import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileRead } from '../types.ts';
import { agentEnv, runProcess, timeoutMessage } from './process.ts';
import { callKey } from './read-tools.ts';
import { HarnessError, type Harness, type HarnessInput, type HarnessResult } from './types.ts';

/** The MCP server that gives Codex its only tools: read, grep and glob inside the workdir. */
export const READ_TOOLS_SERVER = fileURLToPath(new URL('./read-tools-server.ts', import.meta.url));
export const MCP_SERVER = 'review';
const MCP_TOOLS = ['read', 'grep', 'glob'] as const;
/**
 * Codex cuts a tool result longer than this (in its own token estimate) before
 * the model sees it. Set high and explicitly, so it cannot cut what read-tools
 * returns (at most MAX_RESULT_CHARS) and the read log stays true.
 */
export const TOOL_OUTPUT_TOKEN_LIMIT = 20_000;
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Codex features turned off. The shell (`shell_tool`, `unified_exec`) goes:
 * Codex reads files through it, and what the model sees of a command's output
 * is cut in ways the event log does not show, so a shell read could never be
 * proof of reading. Everything else here is a way to reach outside the
 * checkout, run code, or load something the PR could plant.
 */
export const DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
  'multi_agent',
  'goals',
  'view_image',
  'image_generation',
  'apps',
  'plugins',
  'remote_plugin',
  'hooks',
  'skill_search',
  'skill_mcp_dependency_install',
  'tool_suggest',
  'browser_use',
  'computer_use',
  'sleep_tool',
  'daemon_auto_start',
  'in_app_updates',
] as const;

/** A TOML value for `-c key=value`. JSON strings are valid TOML basic strings. */
const toml = (v: string | string[]): string => (Array.isArray(v) ? `[${v.map((s) => JSON.stringify(s)).join(',')}]` : JSON.stringify(v));

export interface CodexArgsInput {
  userMessage: string;
  model: string;
  workdir: string;
  systemPromptFile: string;
  readLog: string;
  baseUrl?: string;
  effort?: string;
}

/**
 * The arguments for one read-only, headless reviewer.
 *
 * - `--ignore-user-config`, `--ignore-rules` and a fresh CODEX_HOME: nothing
 *   from the runner's own Codex setup. `--strict-config` turns a typo in the
 *   overrides below into an error instead of a silently ignored setting.
 * - The model provider is always our own (`nhr`), at base-url or OpenAI's API,
 *   reading the key from OPENAI_API_KEY. No login, no auth.json.
 * - `project_doc_max_bytes=0`: an AGENTS.md in the PR never reaches the model.
 *   `model_instructions_file` replaces Codex's own instructions with ours.
 * - No shell (see DISABLED_FEATURES), no web search, no skills. The only tools
 *   are read-tools-server's read, grep and glob, approved up front because
 *   they only read, with the output limit set so Codex never cuts a result.
 * - `--sandbox read-only` stays on as a second wall.
 */
export function codexArgs(input: CodexArgsInput): string[] {
  const set = (key: string, value: string | string[] | number | boolean) => ['-c', `${key}=${typeof value === 'string' || Array.isArray(value) ? toml(value) : String(value)}`];
  const server = `mcp_servers.${MCP_SERVER}`;
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--cd', input.workdir,
    '--model', input.model,
    ...set('model_provider', 'nhr'),
    ...set('model_providers.nhr.name', 'needs-human-review'),
    ...set('model_providers.nhr.base_url', input.baseUrl || OPENAI_BASE_URL),
    ...set('model_providers.nhr.wire_api', 'responses'),
    ...set('model_providers.nhr.env_key', 'OPENAI_API_KEY'),
    ...set('approval_policy', 'never'),
    ...set('project_doc_max_bytes', 0),
    ...set('model_instructions_file', input.systemPromptFile),
    ...set('web_search', 'disabled'),
    ...set('skills.include_instructions', false),
    ...(input.effort ? set('model_reasoning_effort', input.effort) : []),
    ...set(`${server}.command`, process.execPath),
    ...set(`${server}.args`, [READ_TOOLS_SERVER]),
    '-c', `${server}.env={NHR_ROOT=${toml(input.workdir)},NHR_READ_LOG=${toml(input.readLog)}}`,
    ...set(`${server}.required`, true),
    ...set(`${server}.default_tools_approval_mode`, 'approve'),
    ...set(`${server}.enabled_tools`, [...MCP_TOOLS]),
    ...MCP_TOOLS.flatMap((t) => set(`${server}.tools.${t}.output_token_limit`, TOOL_OUTPUT_TOKEN_LIMIT)),
    ...DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
    // Everything after -- is the prompt, even if it starts with a dash.
    '--',
    input.userMessage,
  ];
}

/** Codex reaches the model with an OpenAI key, read from OPENAI_API_KEY by our provider. */
const CREDENTIALS = /^(OPENAI_API_KEY|OPENAI_ORGANIZATION|OPENAI_PROJECT)$/;

export function codexEnv(source: Record<string, string | undefined>, codexHome: string, apiKey?: string): Record<string, string> {
  const env = agentEnv(source, CREDENTIALS);
  if (apiKey) env.OPENAI_API_KEY = apiKey;
  // A fresh home: no login, config, sessions, skills or plugins from the runner.
  return { ...env, CODEX_HOME: codexHome };
}

interface CodexItem {
  type?: string;
  text?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  status?: string;
}

interface CodexEvent {
  type?: string;
  item?: CodexItem;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
  message?: string;
}

export interface ParsedCodexStream {
  finalText: string;
  /** The arguments of every read call that completed, in the agent's own log. */
  completedReads: string[];
  tokens: { input: number; output: number };
  errors: string[];
  /** A turn.completed or turn.failed event was seen. */
  sawEnd: boolean;
}

function isReadCall(item: CodexItem): boolean {
  return item.type === 'mcp_tool_call' && item.server === MCP_SERVER && item.tool === 'read';
}

/** Parses `codex exec --json` output: one JSON event per line. */
export function parseCodexStream(stdout: string): ParsedCodexStream {
  const parsed: ParsedCodexStream = { finalText: '', completedReads: [], tokens: { input: 0, output: 0 }, errors: [], sawEnd: false };
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let e: CodexEvent;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'item.completed' && e.item) {
      if (e.item.type === 'agent_message' && typeof e.item.text === 'string') parsed.finalText = e.item.text;
      if (isReadCall(e.item) && e.item.status === 'completed' && e.item.arguments && typeof e.item.arguments === 'object') {
        parsed.completedReads.push(callKey(e.item.arguments as Record<string, unknown>));
      }
    } else if (e.type === 'turn.completed') {
      parsed.sawEnd = true;
      parsed.tokens.input += e.usage?.input_tokens ?? 0;
      parsed.tokens.output += e.usage?.output_tokens ?? 0;
    } else if (e.type === 'turn.failed') {
      parsed.sawEnd = true;
      parsed.errors.push((e.error?.message ?? 'turn failed').slice(0, 500));
    }
  }
  // A failed turn has no answer, whatever it said before failing.
  if (parsed.errors.length > 0) parsed.finalText = '';
  return parsed;
}

/**
 * The reads that count: entries of the read log written by read-tools-server,
 * each matched to a read call that Codex's own log shows as completed. An entry
 * with no completed call (the result never reached the model) does not count.
 */
export function matchReads(readLog: string, completedReads: string[]): FileRead[] {
  const open = new Map<string, number>();
  for (const k of completedReads) open.set(k, (open.get(k) ?? 0) + 1);
  const reads: FileRead[] = [];
  for (const line of readLog.split('\n')) {
    if (line.trim() === '') continue;
    let r: { path?: unknown; fromLine?: unknown; toLine?: unknown; call?: unknown };
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const left = typeof r.call === 'string' ? (open.get(r.call) ?? 0) : 0;
    if (left === 0) continue;
    if (typeof r.path !== 'string' || !Number.isInteger(r.fromLine) || !Number.isInteger(r.toLine)) continue;
    const from = r.fromLine as number;
    const to = r.toLine as number;
    if (from < 1 || to < from - 1) continue;
    open.set(r.call as string, left - 1);
    reads.push({ path: r.path, fromLine: from, toLine: to });
  }
  return reads;
}

/** The event log without what the tools returned: file content stays on the runner. */
export function redactCodexStream(stdout: string): string {
  return stdout
    .split('\n')
    .map((line) => {
      if (!line.trim().startsWith('{')) return line;
      try {
        const e = JSON.parse(line) as CodexEvent;
        if (e.item?.type !== 'mcp_tool_call' || e.item.result === undefined || e.item.result === null) return line;
        e.item.result = '[removed]';
        return JSON.stringify(e);
      } catch {
        return '[unparsed line removed]';
      }
    })
    .join('\n');
}

export class CodexHarness implements Harness {
  readonly name = 'codex';
  readonly #bin: string;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string | undefined;
  readonly #effort: string | undefined;

  constructor(settings: { apiKey?: string; baseUrl?: string; effort?: string } = {}, bin = process.env.CODEX_BIN || 'codex') {
    this.#bin = bin;
    this.#apiKey = settings.apiKey || undefined;
    this.#baseUrl = settings.baseUrl || undefined;
    this.#effort = settings.effort || undefined;
  }

  async run(input: HarnessInput): Promise<HarnessResult> {
    const started = Date.now();
    const home = await mkdtemp(join(tmpdir(), 'nhr-codex-'));
    try {
      const systemPromptFile = join(home, 'system-prompt.md');
      const readLog = join(home, 'reads.jsonl');
      await writeFile(systemPromptFile, input.systemPrompt);
      await writeFile(readLog, '');
      const args = codexArgs({
        userMessage: input.userMessage,
        model: input.model,
        workdir: input.workdir,
        systemPromptFile,
        readLog,
        ...(this.#baseUrl ? { baseUrl: this.#baseUrl } : {}),
        ...(this.#effort ? { effort: this.#effort } : {}),
      });
      const env = codexEnv(process.env, home, this.#apiKey);
      const { code, stdout, stderr, timedOut } = await runProcess('codex', this.#bin, args, { cwd: input.workdir, env, timeoutMs: input.timeoutMs });

      const raw = redactCodexStream(stdout);
      if (timedOut) throw new HarnessError(timeoutMessage(input.timeoutMs), raw);
      const parsed = parseCodexStream(stdout);
      if (code !== 0) {
        const why = [...parsed.errors, stderr.trim().slice(-500)].filter((s) => s !== '').join('; ') || 'no error message';
        throw new HarnessError(`codex exited with code ${code}: ${why}`, raw);
      }
      if (!parsed.sawEnd) throw new HarnessError('codex ended without finishing the turn', raw);
      if (parsed.errors.length > 0) throw new HarnessError(`codex reported an error: ${parsed.errors.join('; ')}`, raw);
      if (parsed.finalText.trim() === '') throw new HarnessError('the model gave no final answer', raw);
      return {
        finalText: parsed.finalText,
        raw,
        durationMs: Date.now() - started,
        reads: matchReads(await readFile(readLog, 'utf8'), parsed.completedReads),
        tokens: parsed.tokens,
      };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
