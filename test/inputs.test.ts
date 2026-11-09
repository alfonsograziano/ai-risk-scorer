import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, parseList, readConfig } from '../src/inputs.ts';

test('defaults are the safe ones', () => {
  const c = readConfig({});
  assert.equal(c.mode, 'shadow');
  assert.equal(c.maxLinesChanged, 0);
  assert.equal(c.maxFilesChanged, 0);
  assert.equal(c.maxRiskToMerge, 'low');
  assert.equal(c.minConfidence, 4);
  assert.equal(c.allowForks, false);
  assert.equal(c.generatedDefaults, true);
});

test('inputs are read from INPUT_ variables', () => {
  const c = readConfig({
    INPUT_MODE: 'autonomous',
    INPUT_PROTECTED_PATHS: 'payments/**\n# a comment\n\n*.tf\n',
    INPUT_MAX_LINES_CHANGED: '400',
    INPUT_MIN_CONFIDENCE: '5',
  });
  assert.equal(c.mode, 'autonomous');
  assert.deepEqual(c.protectedPaths, ['payments/**', '*.tf']);
  assert.equal(c.maxLinesChanged, 400);
  assert.equal(c.minConfidence, 5);
});

test('lists are split by line, so globs with commas survive', () => {
  assert.deepEqual(parseList('src/{a,b}/**\n  x  '), ['src/{a,b}/**', 'x']);
});

test('bad config is rejected with every problem listed', () => {
  assert.throws(
    () =>
      readConfig({
        INPUT_MODE: 'yolo',
        INPUT_MIN_CONFIDENCE: '0.7',
        INPUT_SYSTEM_PROMPT: 'a',
        INPUT_SYSTEM_PROMPT_FILE: 'b.md',
        INPUT_MAX_RISK_TO_MERGE: 'high',
      }),
    (e: unknown) => e instanceof ConfigError && e.problems.length === 4,
  );
});

test('the harness defaults to claude-code with its own defaults', () => {
  const c = readConfig({});
  assert.equal(c.harness, 'claude-code');
  assert.deepEqual(c.harnessSettings, { model: 'claude-sonnet-5-5', version: '2.1.319', provider: 'anthropic' });
  assert.equal(c.model, 'claude-sonnet-5-5');
  assert.deepEqual(readConfig({ INPUT_HARNESS: 'opencode' }).harnessSettings, { model: 'opencode/deepseek-v4.1-flash', version: '2.2.5' });
});


test('claude-code takes its settings from harness-settings', () => {
  const d = readConfig({ INPUT_HARNESS: 'claude-code' });
  assert.deepEqual(d.harnessSettings, { model: 'claude-sonnet-5-5', version: '2.1.319', provider: 'anthropic' });
  const c = readConfig({
    INPUT_HARNESS: 'claude-code',
    INPUT_HARNESS_SETTINGS: '# pick the model\nmodel: claude-opus-5-5\n\nversion: 2.1.320\neffort: high\n',
  });
  assert.equal(c.harness, 'claude-code');
  assert.deepEqual(c.harnessSettings, { model: 'claude-opus-5-5', version: '2.1.320', effort: 'high', provider: 'anthropic' });
  assert.equal(c.model, 'claude-opus-5-5');
});

test('setting values may hold colons', () => {
  const c = readConfig({ INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: 'model: arn:aws:bedrock:us-east-1:123:inference-profile/x' });
  assert.equal(c.model, 'arn:aws:bedrock:us-east-1:123:inference-profile/x');
});

test('bad harness settings are rejected', () => {
  const problems = (env: Record<string, string>) => {
    try {
      readConfig(env);
      return [];
    } catch (e) {
      return (e as ConfigError).problems;
    }
  };
  assert.match(problems({ INPUT_HARNESS: 'pi' })[0] ?? '', /harness must be one of opencode, claude-code, codex, fake/);
  assert.match(problems({ INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: 'modle: x' })[0] ?? '', /"modle" is not a setting of the claude-code harness/);
  assert.match(problems({ INPUT_HARNESS: 'opencode', INPUT_HARNESS_SETTINGS: 'effort: high' })[0] ?? '', /"effort" is not a setting of the opencode harness/);
  assert.match(problems({ INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: 'version: latest' })[0] ?? '', /version must be a release number/);
  assert.match(problems({ INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: 'effort: turbo' })[0] ?? '', /effort must be/);
  assert.match(problems({ INPUT_HARNESS: 'opencode', INPUT_HARNESS_SETTINGS: 'model: deepseek' })[0] ?? '', /model must look like provider\/model/);
  assert.match(problems({ INPUT_HARNESS_SETTINGS: 'just a line' })[0] ?? '', /must look like "key: value"/);
  assert.match(problems({ INPUT_HARNESS: 'opencode', INPUT_HARNESS_SETTINGS: 'model: a/b\nmodel: c/d' })[0] ?? '', /sets "model" twice/);
});

test('the model input sets the model, but not together with "model" in harness-settings', () => {
  assert.equal(readConfig({ INPUT_MODEL: 'claude-haiku-5-5' }).model, 'claude-haiku-5-5');
  assert.throws(() => readConfig({ INPUT_MODEL: 'claude-a', INPUT_HARNESS_SETTINGS: 'model: claude-b' }), /set model or "model" in harness-settings, not both/);
  assert.equal(readConfig({ INPUT_OPENCODE_VERSION: '2.2.5' }).harnessSettings.version, '2.1.319', 'the v1.0 opencode-version input is gone');
});

test('api-key is read but kept out of the harness settings', () => {
  const c = readConfig({ INPUT_API_KEY: ' sk-secret ', INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: 'base-url: https://opencode.ai/inference/anthropic\nauth: bearer' });
  assert.equal(c.apiKey, 'sk-secret');
  assert.ok(!JSON.stringify(c.harnessSettings).includes('sk-secret'));
  assert.equal(c.harnessSettings['base-url'], 'https://opencode.ai/inference/anthropic');
  assert.equal(readConfig({}).apiKey, '');
});

test('base-url must be https, or http on localhost, and hold no credentials', () => {
  const ok = (url: string) => readConfig({ INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: `base-url: ${url}` }).harnessSettings['base-url'];
  assert.equal(ok('http://localhost:4000'), 'http://localhost:4000');
  assert.throws(() => ok('http://gw.example.com'), /must use https/);
  assert.throws(() => ok('not a url'), /must be a URL/);
  assert.throws(() => ok('https://user:pw@gw.example.com'), /must not hold credentials/);
  assert.throws(() => readConfig({ INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: 'auth: basic' }), /auth must be x-api-key, bearer or oauth/);
  assert.throws(() => readConfig({ INPUT_HARNESS: 'opencode', INPUT_HARNESS_SETTINGS: 'base-url: https://x.example' }), /"base-url" is not a setting of the opencode harness/);
});

test('a model cannot start with a dash, and an empty setting means the default', () => {
  assert.throws(() => readConfig({ INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: 'model: --dangerously-skip-permissions' }), /model must be one word that does not start with a dash/);
  assert.throws(() => readConfig({ INPUT_HARNESS: 'opencode', INPUT_HARNESS_SETTINGS: 'model: -x/y' }), /model must look like provider\/model/);
  assert.equal(readConfig({ INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: 'model:' }).model, 'claude-sonnet-5-5');
  assert.throws(() => readConfig({ INPUT_HARNESS: 'opencode', INPUT_HARNESS_SETTINGS: 'constructor: x' }), /"constructor" is not a setting of the opencode harness/);
});

test('base-url cannot carry a query or fragment, since it lands in the verdict record', () => {
  const url = (u: string) => readConfig({ INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: `base-url: ${u}` });
  assert.throws(() => url('https://gw.example.com/?key=sk-secret'), /must not hold credentials, a query or a fragment/);
  assert.throws(() => url('https://gw.example.com/#sk-secret'), /must not hold credentials, a query or a fragment/);
});

test('the model input sets the model for any harness and is checked like the setting', () => {
  assert.equal(readConfig({ INPUT_HARNESS: 'opencode', INPUT_MODEL: 'opencode/kimi-k3' }).harnessSettings.model, 'opencode/kimi-k3');
  const c = readConfig({ INPUT_HARNESS: 'claude-code', INPUT_MODEL: 'deepseek-v4.1-flash', INPUT_HARNESS_SETTINGS: 'base-url: https://opencode.ai/inference/anthropic' });
  assert.equal(c.model, 'deepseek-v4.1-flash');
  assert.equal(c.harnessSettings.model, 'deepseek-v4.1-flash', 'the record shows the model with the other settings');
  assert.throws(() => readConfig({ INPUT_HARNESS: 'opencode', INPUT_MODEL: 'deepseek' }), /model must look like provider\/model/);
  assert.throws(() => readConfig({ INPUT_HARNESS: 'claude-code', INPUT_MODEL: '-x' }), /must be one word that does not start with a dash/);
});

test('codex takes model, version, effort and base-url, with its own effort levels', () => {
  assert.deepEqual(readConfig({ INPUT_HARNESS: 'codex' }).harnessSettings, { model: 'gpt-6.1-sol', version: '0.167.0' });
  const c = readConfig({ INPUT_HARNESS: 'codex', INPUT_MODEL: 'glm-5.3', INPUT_HARNESS_SETTINGS: 'effort: minimal\nbase-url: https://opencode.ai/inference/openai/v1' });
  assert.deepEqual(c.harnessSettings, { model: 'glm-5.3', version: '0.167.0', effort: 'minimal', 'base-url': 'https://opencode.ai/inference/openai/v1' });
  assert.throws(() => readConfig({ INPUT_HARNESS: 'codex', INPUT_HARNESS_SETTINGS: 'effort: max' }), /effort must be minimal, low, medium, high or xhigh/);
  assert.throws(() => readConfig({ INPUT_HARNESS: 'codex', INPUT_HARNESS_SETTINGS: 'auth: bearer' }), /"auth" is not a setting of the codex harness/);
});

test('claude-code runs on Anthropic, Bedrock, Vertex AI or Foundry', () => {
  const claude = (settings: string, extra: Record<string, string> = {}) => readConfig({ INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: settings, ...extra });
  assert.equal(claude('').harnessSettings.provider, 'anthropic');
  assert.deepEqual(claude('provider: bedrock\nregion: us-east-1').harnessSettings, { model: 'sonnet', version: '2.1.319', provider: 'bedrock', region: 'us-east-1' }, 'on a cloud the default model is the alias');
  assert.equal(claude('provider: bedrock', { INPUT_MODEL: 'us.anthropic.claude-sonnet-5-5-v1:0' }).model, 'us.anthropic.claude-sonnet-5-5-v1:0');
  assert.equal(claude('provider: vertex\nregion: global\nproject: my-project-123').harnessSettings.project, 'my-project-123');
  assert.equal(claude('provider: foundry\nbase-url: https://my-resource.services.ai.azure.com').harnessSettings.provider, 'foundry');
  assert.equal(claude('auth: oauth', { INPUT_API_KEY: 'sk-ant-oat01-x' }).harnessSettings.auth, 'oauth');
  assert.throws(() => claude('provider: azure'), /provider must be anthropic, bedrock, vertex or foundry/);
  assert.throws(() => claude('provider: bedrock\nauth: bearer'), /auth only applies to provider anthropic/);
  assert.throws(() => claude('region: us-east-1'), /region only applies to provider bedrock or vertex/);
  assert.throws(() => claude('provider: bedrock\nproject: my-project-123'), /project only applies to provider vertex/);
  assert.throws(() => claude('provider: vertex', { INPUT_API_KEY: 'k' }), /Vertex AI takes no key/);
  assert.throws(() => claude('auth: oauth\nbase-url: https://gw.example.com'), /only works with Anthropic's API/);
  assert.throws(() => claude('provider: bedrock\nregion: US East'), /region must look like/);
  assert.throws(() => readConfig({ INPUT_HARNESS: 'opencode', INPUT_MODEL: 'google-vertex/gemini-3-pro', INPUT_API_KEY: 'k' }), /Vertex AI takes no key/);
});
