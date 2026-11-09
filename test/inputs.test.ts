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

test('the harness defaults to opencode with its own defaults', () => {
  const c = readConfig({});
  assert.equal(c.harness, 'opencode');
  assert.deepEqual(c.harnessSettings, { model: 'opencode/deepseek-v4.1-flash', version: '2.2.5' });
  assert.equal(c.model, 'opencode/deepseek-v4.1-flash');
});

test('claude-code takes its settings from harness-settings', () => {
  const d = readConfig({ INPUT_HARNESS: 'claude-code' });
  assert.deepEqual(d.harnessSettings, { model: 'claude-sonnet-5-5', version: '2.1.319' });
  const c = readConfig({
    INPUT_HARNESS: 'claude-code',
    INPUT_HARNESS_SETTINGS: '# pick the model\nmodel: claude-opus-5-5\n\nversion: 2.1.320\neffort: high\n',
  });
  assert.equal(c.harness, 'claude-code');
  assert.deepEqual(c.harnessSettings, { model: 'claude-opus-5-5', version: '2.1.320', effort: 'high' });
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
  assert.match(problems({ INPUT_HARNESS: 'pi' })[0] ?? '', /harness must be one of opencode, claude-code, fake/);
  assert.match(problems({ INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: 'modle: x' })[0] ?? '', /"modle" is not a setting of the claude-code harness/);
  assert.match(problems({ INPUT_HARNESS_SETTINGS: 'effort: high' })[0] ?? '', /"effort" is not a setting of the opencode harness/);
  assert.match(problems({ INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: 'version: latest' })[0] ?? '', /version must be a release number/);
  assert.match(problems({ INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: 'effort: turbo' })[0] ?? '', /effort must be/);
  assert.match(problems({ INPUT_HARNESS_SETTINGS: 'model: deepseek' })[0] ?? '', /model must look like provider\/model/);
  assert.match(problems({ INPUT_HARNESS_SETTINGS: 'just a line' })[0] ?? '', /must look like "key: value"/);
  assert.match(problems({ INPUT_HARNESS_SETTINGS: 'model: a/b\nmodel: c/d' })[0] ?? '', /sets "model" twice/);
});

test('the v1.0 model and opencode-version inputs still work, but not together with harness-settings', () => {
  const c = readConfig({ INPUT_MODEL: 'opencode/other', INPUT_OPENCODE_VERSION: '2.3.0' });
  assert.deepEqual(c.harnessSettings, { model: 'opencode/other', version: '2.3.0' });
  assert.equal(readConfig({ INPUT_HARNESS: 'claude-code', INPUT_MODEL: 'claude-haiku-5-5' }).model, 'claude-haiku-5-5');
  assert.throws(() => readConfig({ INPUT_MODEL: 'opencode/a', INPUT_HARNESS_SETTINGS: 'model: opencode/b' }), /set model or "model" in harness-settings, not both/);
  assert.throws(() => readConfig({ INPUT_HARNESS: 'claude-code', INPUT_OPENCODE_VERSION: '2.2.5' }), /opencode-version only applies to the opencode harness/);
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
  assert.throws(() => readConfig({ INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: 'auth: basic' }), /auth must be x-api-key or bearer/);
  assert.throws(() => readConfig({ INPUT_HARNESS_SETTINGS: 'base-url: https://x.example' }), /"base-url" is not a setting of the opencode harness/);
});

test('a model cannot start with a dash, and an empty setting means the default', () => {
  assert.throws(() => readConfig({ INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: 'model: --dangerously-skip-permissions' }), /model must be one word that does not start with a dash/);
  assert.throws(() => readConfig({ INPUT_HARNESS_SETTINGS: 'model: -x/y' }), /model must look like provider\/model/);
  assert.equal(readConfig({ INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: 'model:' }).model, 'claude-sonnet-5-5');
  assert.throws(() => readConfig({ INPUT_HARNESS_SETTINGS: 'constructor: x' }), /"constructor" is not a setting of the opencode harness/);
});

test('base-url cannot carry a query or fragment, since it lands in the verdict record', () => {
  const url = (u: string) => readConfig({ INPUT_HARNESS: 'claude-code', INPUT_HARNESS_SETTINGS: `base-url: ${u}` });
  assert.throws(() => url('https://gw.example.com/?key=sk-secret'), /must not hold credentials, a query or a fragment/);
  assert.throws(() => url('https://gw.example.com/#sk-secret'), /must not hold credentials, a query or a fragment/);
});
