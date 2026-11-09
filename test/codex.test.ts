import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexHarness, codexArgs, codexEnv, DISABLED_FEATURES, matchReads, parseCodexStream, READ_TOOLS_SERVER, redactCodexStream, TOOL_OUTPUT_TOKEN_LIMIT } from '../src/harness/codex.ts';
import { callKey, MAX_RESULT_CHARS } from '../src/harness/read-tools.ts';
import { HarnessError } from '../src/harness/types.ts';

// Shape of `codex exec --json` (Codex 0.167), with the read-tools MCP server.
const events = [
  { type: 'thread.started', thread_id: 't1' },
  { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `glm-5.3` not found.' } },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_1', type: 'mcp_tool_call', server: 'review', tool: 'read', arguments: { path: 'src/a.ts' }, result: { content: [{ type: 'text', text: '1\tconst a = 1;' }] }, error: null, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'mcp_tool_call', server: 'review', tool: 'read', arguments: { path: '../x' }, result: { content: [{ type: 'text', text: 'outside' }] }, error: null, status: 'failed' } },
  { type: 'item.completed', item: { id: 'item_3', type: 'mcp_tool_call', server: 'review', tool: 'grep', arguments: { pattern: 'a' }, result: { content: [{ type: 'text', text: 'src/a.ts:1: const a' }] }, error: null, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'Thinking.' } },
  { type: 'item.completed', item: { id: 'item_5', type: 'agent_message', text: '{"decision":"safe"}' } },
  { type: 'turn.completed', usage: { input_tokens: 600, cached_input_tokens: 200, output_tokens: 60 } },
];
const stdout = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

test('parseCodexStream takes the last message and the completed read calls', () => {
  const p = parseCodexStream(stdout);
  assert.equal(p.finalText, '{"decision":"safe"}');
  assert.deepEqual(p.completedReads, [callKey({ path: 'src/a.ts' })]);
  assert.deepEqual(p.tokens, { input: 600, output: 60 });
  assert.deepEqual(p.errors, []);
  assert.equal(p.sawEnd, true);

  const failed = parseCodexStream([{ type: 'item.completed', item: { type: 'agent_message', text: '{"decision":"safe"}' } }, { type: 'error', message: 'retrying' }, { type: 'turn.failed', error: { message: '403 Model access is disabled' } }].map((e) => JSON.stringify(e)).join('\n'));
  assert.equal(failed.finalText, '', 'a failed turn has no answer');
  assert.deepEqual(failed.errors, ['403 Model access is disabled']);
  assert.equal(parseCodexStream('').sawEnd, false);
});

test('a logged read counts only when Codex shows that call completed', () => {
  const entry = (path: string, fromLine: number, toLine: number, args: Record<string, unknown>) => JSON.stringify({ path, fromLine, toLine, call: callKey(args) });
  const log = [
    entry('src/a.ts', 1, 2, { path: 'src/a.ts' }),
    entry('big.ts', 1, 400, { path: 'big.ts' }),
    entry('big.ts', 401, 800, { path: 'big.ts', offset: 401 }),
    entry('src/a.ts', 1, 2, { path: 'src/a.ts' }),
    '{not json',
    JSON.stringify({ path: 'x.ts', fromLine: 0, toLine: 5, call: callKey({ path: 'x.ts' }) }),
  ].join('\n');
  const completed = [callKey({ path: 'src/a.ts' }), callKey({ path: 'big.ts', offset: 401 }), callKey({ path: 'x.ts' })];
  assert.deepEqual(matchReads(log, completed), [
    { path: 'src/a.ts', fromLine: 1, toLine: 2 },
    { path: 'big.ts', fromLine: 401, toLine: 800 },
  ], 'big.ts 1-400 never completed, the second a.ts read has no second call, and a bad range is dropped');
});

test('redactCodexStream drops what the tools returned, keeps what ran and the text', () => {
  const raw = redactCodexStream(stdout);
  assert.ok(!raw.includes('const a = 1'));
  assert.ok(raw.includes('"arguments":{"path":"src/a.ts"}'));
  assert.ok(raw.includes('{\\"decision\\":\\"safe\\"}'));
  assert.equal(redactCodexStream('{bad'), '[unparsed line removed]');
});

test('codexArgs gives a reviewer with no shell, no web, no AGENTS.md and only the read tools', () => {
  const args = codexArgs({ userMessage: '-review', model: 'glm-5.3', workdir: '/work "x"', systemPromptFile: '/tmp/p.md', readLog: '/tmp/r.jsonl', baseUrl: 'https://opencode.ai/inference/openai/v1', effort: 'high' });
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  const configs = args.filter((_, i) => args[i - 1] === '-c');
  const config = (key: string) => configs.find((c) => c.startsWith(`${key}=`))?.slice(key.length + 1);
  for (const flag of ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config']) assert.ok(args.includes(flag), flag);
  assert.equal(after('--sandbox'), 'read-only');
  assert.equal(after('--model'), 'glm-5.3');
  assert.equal(config('model_providers.nhr.base_url'), '"https://opencode.ai/inference/openai/v1"');
  assert.equal(config('model_providers.nhr.env_key'), '"OPENAI_API_KEY"');
  assert.equal(config('project_doc_max_bytes'), '0');
  assert.equal(config('web_search'), '"disabled"');
  assert.equal(config('approval_policy'), '"never"');
  assert.equal(config('model_instructions_file'), '"/tmp/p.md"');
  assert.equal(config('model_reasoning_effort'), '"high"');
  assert.equal(config('mcp_servers.review.args'), `[${JSON.stringify(READ_TOOLS_SERVER)}]`);
  assert.equal(config('mcp_servers.review.env'), '{NHR_ROOT="/work \\"x\\"",NHR_READ_LOG="/tmp/r.jsonl"}', 'paths are quoted for TOML');
  assert.equal(config('mcp_servers.review.enabled_tools'), '["read","grep","glob"]');
  for (const f of ['shell_tool', 'unified_exec', 'multi_agent', 'hooks', 'plugins']) assert.ok(args.includes(f) && DISABLED_FEATURES.includes(f as never), f);
  assert.deepEqual(args.slice(-2), ['--', '-review'], 'the message is never read as a flag');
  const plain = codexArgs({ userMessage: 'm', model: 'gpt-6.1-sol', workdir: '/w', systemPromptFile: 'p', readLog: 'r' });
  assert.ok(plain.includes('model_providers.nhr.base_url="https://api.openai.com/v1"'));
  assert.ok(!plain.some((a) => a.startsWith('model_reasoning_effort')));
});

test('Codex never cuts a read result, so the read log is what the model saw', () => {
  // Codex estimates about 4 characters per token. Keep a wide margin.
  assert.ok(MAX_RESULT_CHARS / 4 <= TOOL_OUTPUT_TOKEN_LIMIT / 2);
});

test('codexEnv passes only the OpenAI key, and api-key wins', () => {
  const env = codexEnv({ PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'job', ANTHROPIC_API_KEY: 'a', OPENCODE_API_KEY: 'o', INPUT_API_KEY: 'i', GITHUB_TOKEN: 'g', CODEX_HOME: '/runner/.codex' }, '/tmp/home');
  assert.deepEqual(Object.keys(env).sort(), ['CODEX_HOME', 'HOME', 'OPENAI_API_KEY', 'PATH']);
  assert.equal(env.CODEX_HOME, '/tmp/home', 'never the runner\'s own Codex home');
  assert.equal(codexEnv({ OPENAI_API_KEY: 'job' }, '/h', 'input').OPENAI_API_KEY, 'input');
});

/** A stand-in `codex` that records its call, writes a read log entry like the MCP server would, and prints a fixed stream. */
async function fakeCodex(output: string, exitCode = 0): Promise<{ bin: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'nhr-fake-codex-'));
  await writeFile(join(dir, 'out.jsonl'), output);
  const entry = JSON.stringify({ path: 'src/a.ts', fromLine: 1, toLine: 2, call: callKey({ path: 'src/a.ts' }) });
  const bin = join(dir, 'codex');
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' "$@" > '${dir}/args.txt'
env > '${dir}/env.txt'
log=$(printf '%s\\n' "$@" | sed -n 's/.*NHR_READ_LOG="\\([^"]*\\)".*/\\1/p')
printf '%s\\n' '${entry}' >> "$log"
cat '${dir}/out.jsonl'
exit ${exitCode}
`,
  );
  await chmod(bin, 0o755);
  return { bin, dir };
}

const homes = async () => (await readdir(tmpdir())).filter((f) => f.startsWith('nhr-codex-')).length;

test('CodexHarness runs the CLI and returns the answer and the matched reads', async () => {
  const { bin, dir } = await fakeCodex(stdout);
  const before = await homes();
  const prev = process.env.INPUT_GITHUB_TOKEN;
  process.env.INPUT_GITHUB_TOKEN = 'ghs_secret';
  try {
    const r = await new CodexHarness({ apiKey: 'oc_key', baseUrl: 'https://opencode.ai/inference/openai/v1' }, bin).run({ systemPrompt: 'S', userMessage: 'review it', workdir: dir, model: 'glm-5.3', timeoutMs: 10_000 });
    assert.equal(r.finalText, '{"decision":"safe"}');
    assert.deepEqual(r.reads, [{ path: 'src/a.ts', fromLine: 1, toLine: 2 }]);
    assert.ok(!r.raw.includes('const a = 1'));
  } finally {
    if (prev === undefined) delete process.env.INPUT_GITHUB_TOKEN;
    else process.env.INPUT_GITHUB_TOKEN = prev;
  }
  const env = await readFile(join(dir, 'env.txt'), 'utf8');
  assert.ok(!env.includes('ghs_secret'));
  assert.match(env, /^OPENAI_API_KEY=oc_key$/m);
  assert.deepEqual((await readFile(join(dir, 'args.txt'), 'utf8')).trim().split('\n').slice(-2), ['--', 'review it']);
  assert.equal(await homes(), before, 'the Codex home is removed');
});

test('CodexHarness fails on a non-zero exit, a failed turn, no end or no answer', async () => {
  const run = async (out: string, code = 0) => {
    const { bin, dir } = await fakeCodex(out, code);
    return new CodexHarness({}, bin).run({ systemPrompt: 'S', userMessage: 'm', workdir: dir, model: 'm', timeoutMs: 10_000 });
  };
  const failed = `${JSON.stringify({ type: 'turn.failed', error: { message: '403 Model access is disabled' } })}\n`;
  await assert.rejects(run(failed, 1), (e: unknown) => e instanceof HarnessError && /exited with code 1: 403 Model access is disabled/.test(e.message));
  await assert.rejects(run(failed, 0), (e: unknown) => e instanceof HarnessError && /reported an error/.test(e.message));
  await assert.rejects(run(''), (e: unknown) => e instanceof HarnessError && /without finishing the turn/.test(e.message));
  await assert.rejects(run(`${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`), (e: unknown) => e instanceof HarnessError && /no final answer/.test(e.message));
  await assert.rejects(new CodexHarness({}, '/nope/codex').run({ systemPrompt: 'S', userMessage: 'm', workdir: tmpdir(), model: 'm', timeoutMs: 1_000 }), /could not start codex/);
});
