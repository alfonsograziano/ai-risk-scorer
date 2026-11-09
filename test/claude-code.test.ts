import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeHarness, claudeArgs, claudeEnv, keyVariable, parseStream, readFromResult, redactStream } from '../src/harness/claude-code.ts';
import { HarnessError } from '../src/harness/types.ts';

// Shape of `claude --print --output-format stream-json --verbose` (Claude Code 2.1).
const events = [
  { type: 'system', subtype: 'init', cwd: '/work', tools: ['Glob', 'Grep', 'Read'], mcp_servers: [], permissionMode: 'dontAsk' },
  { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/work/src/a.ts' } }] } },
  {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '     1\tconst a = 1;\n     2\texport { a };' }] },
    tool_use_result: { type: 'text', file: { filePath: '/work/src/a.ts', content: 'const a = 1;\nexport { a };', startLine: 1, numLines: 2, totalLines: 2 } },
  },
  // Two results in one message: the structured result is ambiguous, so the numbered text decides.
  {
    type: 'assistant',
    message: {
      id: 'm2',
      content: [
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/work/src/b.ts', offset: 10, limit: 2 } },
        { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/work/secret.ts' } },
        { type: 'tool_use', id: 't4', name: 'Grep', input: { pattern: 'a', path: '/work/src/c.ts' } },
      ],
    },
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: '    10→x\n    11→y\n\n<system-reminder>\n    99→not a line\n</system-reminder>' }] },
        { type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'Permission to use Read has been denied.' },
        { type: 'tool_result', tool_use_id: 't4', content: 'src/c.ts:1:a' },
      ],
    },
    tool_use_result: { type: 'text', file: { filePath: '/work/src/b.ts', startLine: 1, numLines: 500 } },
  },
  { type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: '{"decision":"safe"}' }] } },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done.\n{"decision":"safe"}',
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 80 },
  },
];
const stdout = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

test('parseStream takes reads from successful Read results, and the answer from the result event', () => {
  const p = parseStream('/work', stdout);
  assert.deepEqual(p.reads, [
    { path: 'src/a.ts', fromLine: 1, toLine: 2 },
    { path: 'src/b.ts', fromLine: 10, toLine: 11 },
  ]);
  assert.equal(p.finalText, 'Done.\n{"decision":"safe"}');
  assert.equal(p.costUsd, 0.0123);
  assert.deepEqual(p.tokens, { input: 6100, output: 80 });
  assert.deepEqual(p.errors, []);
  assert.equal(p.sawResult, true);
});

test('a failed run is an error even when its subtype says success', () => {
  const failed = [
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Invalid API key' }] } },
    { type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key' },
  ];
  const p = parseStream('/work', failed.map((e) => JSON.stringify(e)).join('\n'));
  assert.equal(p.finalText, '');
  assert.equal(p.errors.length, 1);
  assert.match(p.errors[0] ?? '', /Invalid API key/);

  const maxTurns = parseStream('/work', JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: false, result: '{"decision":"safe"}' }));
  assert.equal(maxTurns.finalText, '', 'a run cut off by the turn limit has no answer');
  assert.deepEqual(maxTurns.errors, ['error_max_turns: {"decision":"safe"}']);
});

test('readFromResult never guesses a range', () => {
  const read = (input: Record<string, unknown>, content: unknown, structured?: unknown) => readFromResult('/work', input, { content, structured });
  assert.deepEqual(read({ file_path: '/work/e.ts' }, '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>'), { path: 'e.ts', fromLine: 1, toLine: 0 });
  assert.deepEqual(read({ file_path: '/work/e.ts' }, '', { type: 'text', file: { filePath: '/work/e.ts', startLine: 1, numLines: 0 } }), { path: 'e.ts', fromLine: 1, toLine: 0 });
  assert.equal(read({ file_path: '/work/x.ts', offset: 1, limit: 2000 }, 'something we cannot parse'), undefined, 'what the model asked for is not proof');
  assert.equal(read({ file_path: '/work/x.ts' }, 'File unchanged since last read.', { type: 'file_unchanged', file: { filePath: '/work/x.ts' } }), undefined);
  assert.deepEqual(read({ file_path: 'rel/y.ts' }, '     5\tz'), { path: 'rel/y.ts', fromLine: 5, toLine: 5 });
});

test('redactStream drops what the tools returned, keeps what ran and the text', () => {
  const raw = redactStream(stdout);
  assert.ok(!raw.includes('const a = 1'), 'file content is removed');
  assert.ok(!raw.includes('src/c.ts:1:a'), 'grep output is removed');
  assert.ok(raw.includes('"file_path":"/work/src/a.ts"'), 'the tool input stays');
  assert.ok(raw.includes('Reading.'), 'model text stays');
  assert.ok(raw.includes('"decision\\":\\"safe\\"'), 'the answer stays');
  assert.equal(redactStream('{not json'), '[unparsed line removed]');
});

test('claudeArgs gives a read-only reviewer with no shell, web, MCP, skills or project settings', () => {
  const args = claudeArgs({ userMessage: '-starts with a dash', model: 'claude-sonnet-5-5', systemPromptFile: '/tmp/p.md', effort: 'high' });
  for (const flag of ['--print', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(args.includes(flag), flag);
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(after('--tools'), 'Read,Grep,Glob');
  assert.equal(after('--allowedTools'), 'Read,Grep,Glob');
  assert.equal(after('--permission-mode'), 'dontAsk');
  assert.equal(after('--system-prompt-file'), '/tmp/p.md');
  assert.equal(after('--model'), 'claude-sonnet-5-5');
  assert.equal(after('--effort'), 'high');
  assert.equal(after('--output-format'), 'stream-json');
  assert.deepEqual(args.slice(-2), ['--', '-starts with a dash'], 'the message is never read as a flag');
  assert.ok(!args.includes('--mcp-config') && !args.some((a) => /Bash|WebFetch|Edit|Write/.test(a)));
  assert.ok(!claudeArgs({ userMessage: 'm', model: 'x', systemPromptFile: 'p' }).includes('--effort'));
});

test('claudeEnv passes model credentials only, and turns off CLAUDE.md and memory', () => {
  const env = claudeEnv(
    {
      PATH: '/bin',
      HOME: '/home/r',
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_BASE_URL: 'https://proxy',
      CLAUDE_CODE_OAUTH_TOKEN: 'o',
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: 'us-east-1',
      INPUT_GITHUB_TOKEN: 'ghs_x',
      GITHUB_TOKEN: 'ghs_y',
      ACTIONS_RUNTIME_TOKEN: 'a',
      RUNNER_TEMP: '/t',
      OPENCODE_API_KEY: 'other harness',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0',
      NPM_TOKEN: 'n',
    },
    '/tmp/cfg',
  );
  assert.deepEqual(Object.keys(env).sort(), [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'AWS_REGION',
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
    'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
    'DISABLE_AUTOUPDATER',
    'HOME',
    'PATH',
  ]);
  assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1', 'the job cannot turn CLAUDE.md back on');
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined, 'the provider setting, not the job env, picks where the model runs');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/cfg');
});

test('api-key goes in as x-api-key for Anthropic, and as a bearer token for a gateway', () => {
  const job = { ANTHROPIC_API_KEY: 'from-job', ANTHROPIC_AUTH_TOKEN: 'job-token', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', PATH: '/bin' };
  assert.equal(keyVariable({}), 'ANTHROPIC_API_KEY');
  assert.equal(keyVariable({ baseUrl: 'https://opencode.ai/inference/anthropic' }), 'ANTHROPIC_AUTH_TOKEN');
  assert.equal(keyVariable({ baseUrl: 'https://gw.example', auth: 'x-api-key' }), 'ANTHROPIC_API_KEY');
  assert.equal(keyVariable({ auth: 'bearer' }), 'ANTHROPIC_AUTH_TOKEN');

  const direct = claudeEnv(job, '/c', { apiKey: 'input-key' });
  assert.equal(direct.ANTHROPIC_API_KEY, 'input-key');
  assert.equal(direct.ANTHROPIC_AUTH_TOKEN, undefined, 'only the input key is sent');
  assert.equal(direct.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(direct.ANTHROPIC_BASE_URL, undefined);

  const gateway = claudeEnv({ ...job, ANTHROPIC_BASE_URL: 'https://old.example' }, '/c', { apiKey: 'oc_sk_1', baseUrl: 'https://opencode.ai/inference/anthropic' });
  assert.equal(gateway.ANTHROPIC_AUTH_TOKEN, 'oc_sk_1');
  assert.equal(gateway.ANTHROPIC_API_KEY, undefined);
  assert.equal(gateway.ANTHROPIC_BASE_URL, 'https://opencode.ai/inference/anthropic', 'the setting wins over the job env');

  const noInput = claudeEnv(job, '/c', {});
  assert.equal(noInput.ANTHROPIC_API_KEY, 'from-job', 'without api-key the job env is used as before');
});

/** A stand-in `claude` that records how it was called and prints a fixed stream. */
async function fakeClaude(output: string, exitCode = 0): Promise<{ bin: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'nhr-fake-claude-'));
  await writeFile(join(dir, 'out.jsonl'), output);
  const bin = join(dir, 'claude');
  const script = `#!/bin/sh
printf '%s\\n' "$@" > '${dir}/args.txt'
env > '${dir}/env.txt'
cat "$CLAUDE_CONFIG_DIR/system-prompt.md" > '${dir}/prompt.txt'
cat '${dir}/out.jsonl'
exit ${exitCode}
`;
  await writeFile(bin, script);
  await chmod(bin, 0o755);
  return { bin, dir };
}

const nhrTempDirs = async () => (await readdir(tmpdir())).filter((f) => f.startsWith('nhr-claude-')).length;

test('ClaudeCodeHarness runs the CLI in the workdir and returns the answer and reads', async () => {
  const { bin, dir } = await fakeClaude(stdout);
  const before = await nhrTempDirs();
  const prev = process.env.INPUT_GITHUB_TOKEN;
  process.env.INPUT_GITHUB_TOKEN = 'ghs_secret';
  try {
    const r = await new ClaudeCodeHarness({ effort: 'low', apiKey: 'oc_sk_test', baseUrl: 'https://opencode.ai/inference/anthropic' }, bin).run({ systemPrompt: 'SYSTEM PROMPT', userMessage: 'review it', workdir: dir, model: 'claude-haiku-5-5', timeoutMs: 10_000 });
    assert.equal(r.finalText, 'Done.\n{"decision":"safe"}');
    assert.equal(r.reads.length, 2);
    assert.equal(r.costUsd, 0.0123);
    assert.ok(!r.raw.includes('const a = 1'));
  } finally {
    if (prev === undefined) delete process.env.INPUT_GITHUB_TOKEN;
    else process.env.INPUT_GITHUB_TOKEN = prev;
  }
  assert.equal(await readFile(join(dir, 'prompt.txt'), 'utf8'), 'SYSTEM PROMPT');
  const args = (await readFile(join(dir, 'args.txt'), 'utf8')).trim().split('\n');
  assert.deepEqual(args.slice(-2), ['--', 'review it']);
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  const env = await readFile(join(dir, 'env.txt'), 'utf8');
  assert.ok(!env.includes('ghs_secret'), 'the GitHub token never reaches the agent');
  assert.match(env, /^ANTHROPIC_AUTH_TOKEN=oc_sk_test$/m);
  assert.match(env, /^ANTHROPIC_BASE_URL=https:\/\/opencode\.ai\/inference\/anthropic$/m);
  assert.equal(await nhrTempDirs(), before, 'the config folder is removed');
});

test('ClaudeCodeHarness fails on a non-zero exit, an error result or no result', async () => {
  const run = async (out: string, code = 0) => {
    const { bin, dir } = await fakeClaude(out, code);
    return new ClaudeCodeHarness({}, bin).run({ systemPrompt: 'S', userMessage: 'm', workdir: dir, model: 'm', timeoutMs: 10_000 });
  };
  const authError = `${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key' })}\n`;
  await assert.rejects(run(authError, 1), (e: unknown) => e instanceof HarnessError && /exited with code 1: Invalid API key/.test(e.message));
  await assert.rejects(run(authError, 0), (e: unknown) => e instanceof HarnessError && /reported an error/.test(e.message));
  await assert.rejects(run(''), (e: unknown) => e instanceof HarnessError && /without a result/.test(e.message));
  const empty = `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '  ' })}\n`;
  await assert.rejects(run(empty), (e: unknown) => e instanceof HarnessError && /no final answer/.test(e.message));
  await assert.rejects(new ClaudeCodeHarness({}, '/nope/claude').run({ systemPrompt: 'S', userMessage: 'm', workdir: tmpdir(), model: 'm', timeoutMs: 1_000 }), /could not start claude/);
});

test('file content cannot fake line numbers with a line separator', () => {
  // Line 2 of the file holds U+2028 and \r followed by what looks like more numbered lines.
  const text = '     1→a\n     2→b\u2028     3→fake\r     4→fake';
  assert.deepEqual(readFromResult('/work', { file_path: '/work/f.ts' }, { content: text }), { path: 'f.ts', fromLine: 1, toLine: 2 });
});

test('each provider gets its own switch, key variable, base URL and region', () => {
  const job = { PATH: '/bin', ANTHROPIC_API_KEY: 'job', CLAUDE_CODE_USE_VERTEX: '1', AWS_ACCESS_KEY_ID: 'AKIA', AWS_SESSION_TOKEN: 's', AWS_REGION: 'eu-west-1', GOOGLE_CLOUD_PROJECT: 'gcp-proj', GOOGLE_APPLICATION_CREDENTIALS: '/t/creds.json', AWS_BEARER_TOKEN_BEDROCK: 'old' };
  assert.equal(keyVariable({ auth: 'oauth' }), 'CLAUDE_CODE_OAUTH_TOKEN');
  assert.equal(keyVariable({ provider: 'bedrock' }), 'AWS_BEARER_TOKEN_BEDROCK');
  assert.equal(keyVariable({ provider: 'foundry' }), 'ANTHROPIC_FOUNDRY_API_KEY');
  assert.equal(keyVariable({ provider: 'vertex' }), undefined);

  const oauth = claudeEnv(job, '/c', { apiKey: 'sk-ant-oat01-x', auth: 'oauth' });
  assert.equal(oauth.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-x');
  assert.equal(oauth.ANTHROPIC_API_KEY, undefined, 'only the subscription token is sent');
  assert.equal(oauth.CLAUDE_CODE_USE_VERTEX, undefined);

  const oidc = claudeEnv(job, '/c', { provider: 'bedrock', region: 'us-east-1' });
  assert.equal(oidc.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(oidc.CLAUDE_CODE_USE_VERTEX, undefined);
  assert.equal(oidc.AWS_REGION, 'us-east-1', 'the setting wins over the job env');
  assert.equal(oidc.AWS_SESSION_TOKEN, 's', 'OIDC credentials from configure-aws-credentials pass through');
  const bedrockKey = claudeEnv(job, '/c', { provider: 'bedrock', apiKey: 'bedrock-key', baseUrl: 'https://bedrock.gw.example' });
  assert.equal(bedrockKey.AWS_BEARER_TOKEN_BEDROCK, 'bedrock-key');
  assert.equal(bedrockKey.ANTHROPIC_BEDROCK_BASE_URL, 'https://bedrock.gw.example');
  assert.equal(bedrockKey.ANTHROPIC_BASE_URL, undefined);

  const vertex = claudeEnv(job, '/c', { provider: 'vertex', region: 'global' });
  assert.equal(vertex.CLAUDE_CODE_USE_VERTEX, '1');
  assert.equal(vertex.CLOUD_ML_REGION, 'global');
  assert.equal(vertex.ANTHROPIC_VERTEX_PROJECT_ID, 'gcp-proj', 'the project google-github-actions/auth sets is used');
  assert.equal(vertex.GOOGLE_APPLICATION_CREDENTIALS, '/t/creds.json');
  assert.equal(claudeEnv(job, '/c', { provider: 'vertex', project: 'mine-123' }).ANTHROPIC_VERTEX_PROJECT_ID, 'mine-123');

  const foundry = claudeEnv({ PATH: '/bin', AZURE_CLIENT_ID: 'c' }, '/c', { provider: 'foundry', baseUrl: 'https://r.services.ai.azure.com', apiKey: 'fk' });
  assert.equal(foundry.CLAUDE_CODE_USE_FOUNDRY, '1');
  assert.equal(foundry.ANTHROPIC_FOUNDRY_BASE_URL, 'https://r.services.ai.azure.com');
  assert.equal(foundry.ANTHROPIC_FOUNDRY_API_KEY, 'fk');
  assert.equal(foundry.AZURE_CLIENT_ID, 'c');
});
