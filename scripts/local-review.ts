// Runs the full scorer on a local git repo, without GitHub: hard gates, the
// review workspace, the AI review and the decision. The repo is never touched:
// the review runs in a temporary worktree at the head commit.
//
//   node scripts/local-review.ts --repo ../my-repo --base main --head my-branch
//
// Options: --title, --body, --harness (opencode, claude-code or codex), --model,
// --effort, --base-url (claude-code, codex), --auth (claude-code), --mode, --protected <glob> (repeat),
// --max-lines, --max-files, --slice-max-tokens, --custom-instructions,
// --dry (fake harness, no model call), --json <file> (write the full record).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import { createHarness } from '../src/harness/create.ts';
import { FakeHarness } from '../src/harness/fake.ts';
import { readConfig } from '../src/inputs.ts';
import { renderReport, verdictRecord } from '../src/report.ts';
import { scorePullRequest } from '../src/score.ts';
import { git } from '../src/workspace.ts';

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: '.' },
    base: { type: 'string', default: 'main' },
    head: { type: 'string', default: 'HEAD' },
    title: { type: 'string' },
    body: { type: 'string', default: '' },
    harness: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    'base-url': { type: 'string' },
    auth: { type: 'string' },
    mode: { type: 'string', default: 'autonomous' },
    protected: { type: 'string', multiple: true, default: [] },
    'max-lines': { type: 'string' },
    'max-files': { type: 'string' },
    'slice-max-tokens': { type: 'string' },
    'custom-instructions': { type: 'string' },
    dry: { type: 'boolean', default: false },
    json: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log('Usage: node scripts/local-review.ts --repo <path> --base <ref> --head <ref> [--title ...] [--harness opencode|claude-code|codex] [--model ...] [--dry] [--json out.json]');
  process.exit(0);
}

// The default harness (Claude Code) and each harness's default model are the
// same as in CI. Claude Code needs ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN
// or cloud credentials; Codex needs OPENAI_API_KEY. Locally OpenCode takes the
// key from your console login, or from OPENCODE_API_KEY if that is set.
// API_KEY, if set, is the generic api-key input: the harness puts it where its agent reads it.
const given = { model: values.model, effort: values.effort, 'base-url': values['base-url'], auth: values.auth };
const settings = Object.entries(given)
  .filter(([, v]) => v)
  .map(([k, v]) => `${k}: ${v}`)
  .join('\n');
const env: Record<string, string> = { INPUT_MODE: values.mode, INPUT_HARNESS: values.harness ?? '', INPUT_HARNESS_SETTINGS: settings, INPUT_API_KEY: process.env.API_KEY ?? '' };
if (values.protected.length > 0) env.INPUT_PROTECTED_PATHS = values.protected.join('\n');
if (values['max-lines']) env.INPUT_MAX_LINES_CHANGED = values['max-lines'];
if (values['max-files']) env.INPUT_MAX_FILES_CHANGED = values['max-files'];
if (values['slice-max-tokens']) env.INPUT_SLICE_MAX_TOKENS = values['slice-max-tokens'];
if (values['custom-instructions']) env.INPUT_CUSTOM_INSTRUCTIONS = values['custom-instructions'];
const config = readConfig(env);

const repo = resolve(values.repo);
const baseSha = (await git(repo, ['rev-parse', values.base])).trim();
const headSha = (await git(repo, ['rev-parse', values.head])).trim();
const title = values.title ?? (await git(repo, ['log', '-1', '--format=%s', headSha])).trim();

const worktree = await mkdtemp(join(tmpdir(), 'ars-local-'));
await git(repo, ['worktree', 'add', '--detach', '-q', worktree, headSha]);

const harness = values.dry
  ? new FakeHarness(() => ({ error: 'dry run: no model was called' }))
  : createHarness(config.harness, config.harnessSettings, config.apiKey);

try {
  const result = await scorePullRequest({
    repoDir: worktree,
    baseSha,
    headSha,
    pr: { number: 0, title, body: values.body, author: 'local', authorIsBot: false, baseRef: values.base, headSha },
    facts: { isFork: false, labels: [] },
    config,
    harness,
    readBaseFile: async (path) => git(repo, ['show', `${baseSha}:${path}`]),
    lock: true,
    log: (line) => console.error(styleText('dim', `  ${line}`)),
  });
  const report = { result, mode: config.mode, action: 'none' as const, headSha, model: config.model };
  const verdict = result.mergeAllowed ? styleText(['bold', 'green'], 'SAFE TO MERGE') : styleText(['bold', 'red'], 'NEEDS A HUMAN');
  console.log(`\n${verdict}  (stopped at: ${result.stoppedAt})\n`);
  console.log(renderReport(report));
  if (values.json) await writeFile(values.json, JSON.stringify(verdictRecord(report, config, { number: 0, title }), null, 2));
} finally {
  await git(repo, ['worktree', 'remove', '--force', worktree]).catch(async () => {
    await rm(worktree, { recursive: true, force: true });
    await git(repo, ['worktree', 'prune']);
  });
}
