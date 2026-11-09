import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opencodeConfig, parseEvents, readFromToolPart } from '../src/harness/opencode.ts';

// Shape copied from a real `opencode run --format json` run (OpenCode 2.0.20).
const events = [
  { type: 'step_start', part: { type: 'step-start', messageID: 'm1' } },
  {
    type: 'tool_use',
    part: {
      messageID: 'm1',
      type: 'tool',
      tool: 'read',
      state: { status: 'completed', input: { path: 'src/a.ts' }, output: 'Read file src/a.ts, lines 1-2000\n1: x' },
    },
  },
  {
    type: 'tool_use',
    part: { messageID: 'm1', type: 'tool', tool: 'read', state: { status: 'error', input: { path: 'secret.ts' }, output: '' } },
  },
  { type: 'step_finish', part: { type: 'step-finish', cost: 0.002, tokens: { input: 12000, output: 40 } } },
  { type: 'text', part: { messageID: 'm1', type: 'text', text: 'Thinking out loud.' } },
  { type: 'text', part: { messageID: 'm2', type: 'text', text: '{"decision":' } },
  { type: 'text', part: { messageID: 'm2', type: 'text', text: '"safe"}' } },
  { type: 'step_finish', part: { type: 'step-finish', cost: 0.001, tokens: { input: 13000, output: 60 } } },
];
const stdout = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

test('parseEvents takes reads from completed read calls, and the last message as the answer', () => {
  const p = parseEvents('/work', stdout);
  assert.deepEqual(p.reads, [{ path: 'src/a.ts', fromLine: 1, toLine: 2000 }]);
  assert.equal(p.finalText, '{"decision":"safe"}');
  assert.equal(Math.round(p.costUsd * 1000), 3);
  assert.deepEqual(p.tokens, { input: 25000, output: 100 });
});

test('absolute read paths become relative to the workdir', () => {
  const r = readFromToolPart('/work/repo', {
    tool: 'read',
    state: { status: 'completed', input: { filePath: '/work/repo/src/b.ts', offset: 10, limit: 5 }, output: 'no header' },
  });
  assert.deepEqual(r, { path: 'src/b.ts', fromLine: 10, toLine: 14 });
});

test('only read, grep and glob are allowed, after a deny-all rule', () => {
  const cfg = opencodeConfig('SYSTEM', 'opencode/deepseek-v4.1-flash') as { agents: Record<string, { system: string; permissions: { action: string; effect: string }[] }> };
  const agent = cfg.agents['human-review'];
  assert.equal(agent?.system, 'SYSTEM');
  assert.deepEqual(agent?.permissions[0], { action: '*', resource: '*', effect: 'deny' });
  const allowed = agent?.permissions.filter((p) => p.effect === 'allow').map((p) => p.action);
  assert.deepEqual(allowed, ['read', 'grep', 'glob']);
});

test('integrations are denied, except the provider of the model', () => {
  const cfg = opencodeConfig('SYSTEM', 'opencode/deepseek-v4.1-flash') as { policies: { action: string; resource: string; effect: string }[] };
  const integration = cfg.policies.filter((p) => p.action === 'integration.use');
  assert.deepEqual(integration, [
    { action: 'integration.use', resource: '*', effect: 'deny' },
    { action: 'integration.use', resource: 'opencode', effect: 'allow' },
  ]);
});

test('the agent gets no action inputs, GitHub or runner variables', async () => {
  const { harnessEnv } = await import('../src/harness/opencode.ts');
  const env = harnessEnv({
    PATH: '/bin',
    HOME: '/home/r',
    OPENCODE_API_KEY: 'k',
    ANTHROPIC_API_KEY: 'k2',
    INPUT_GITHUB_TOKEN: 'secret',
    GITHUB_TOKEN: 'secret',
    ACTIONS_RUNTIME_TOKEN: 'secret',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret',
    RUNNER_TEMP: '/tmp',
    SOME_OTHER_SECRET: 'secret',
  });
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'HOME', 'OPENCODE_API_KEY', 'PATH']);
});

test('tool output is removed from the kept event log', async () => {
  const { redactEvents } = await import('../src/harness/opencode.ts');
  const raw = redactEvents(stdout);
  assert.ok(!raw.includes('1: x'));
  assert.ok(raw.includes('"path":"src/a.ts"'));
  assert.ok(raw.includes('Thinking out loud.'));
});

test('api-key goes in the variable of the model provider', async () => {
  const { keyVariable } = await import('../src/harness/opencode.ts');
  assert.equal(keyVariable('opencode/deepseek-v4.1-flash'), 'OPENCODE_API_KEY');
  assert.equal(keyVariable('opencode-go/kimi-k3'), 'OPENCODE_API_KEY');
  assert.equal(keyVariable('anthropic/claude-sonnet-5-5'), 'ANTHROPIC_API_KEY');
  assert.equal(keyVariable('openai/gpt-6'), 'OPENAI_API_KEY');
  assert.equal(keyVariable('google/gemini-3-pro'), 'GOOGLE_GENERATIVE_AI_API_KEY');
  assert.equal(keyVariable('deep-infra/x'), 'DEEP_INFRA_API_KEY');
});
