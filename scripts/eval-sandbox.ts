// Runs every sandbox scenario through the full scorer with the real model and
// writes a results table to eval/results.md. Hard-gate scenarios cost nothing;
// the others are one small reviewer run each.
//
//   node scripts/eval-sandbox.ts [--harness claude-code] [--model ...] [--only find-user-null]
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import { createHarness } from '../src/harness/create.ts';
import { readConfig } from '../src/inputs.ts';
import { stars, verdictRecord } from '../src/report.ts';
import { scorePullRequest } from '../src/score.ts';
import { git } from '../src/workspace.ts';
import { makeSandbox, SCENARIOS } from './make-sandbox.ts';

const { values } = parseArgs({ options: { harness: { type: 'string', default: 'opencode' }, model: { type: 'string' }, only: { type: 'string', multiple: true, default: [] } } });
const config = readConfig({
  INPUT_MODE: 'shadow',
  INPUT_PROTECTED_PATHS: 'src/payments/**',
  INPUT_HARNESS: values.harness,
  // Each harness's default model, unless --model says otherwise.
  INPUT_HARNESS_SETTINGS: values.model ? `model: ${values.model}` : '',
});

const root = await mkdtemp(join(tmpdir(), 'ars-eval-'));
const repo = join(root, 'sandbox');
await makeSandbox(repo);
await mkdir('eval/runs', { recursive: true });
const baseSha = (await git(repo, ['rev-parse', 'main'])).trim();

const rows: string[] = [];
let total = 0;
let right = 0;
let cost = 0;
for (const s of SCENARIOS) {
  if (values.only.length > 0 && !values.only.includes(s.branch)) continue;
  const headSha = (await git(repo, ['rev-parse', s.branch])).trim();
  const worktree = join(root, `wt-${s.branch}`);
  await git(repo, ['worktree', 'add', '--detach', '-q', worktree, headSha]);
  console.log(styleText('bold', `\n${s.branch}`), styleText('dim', `expected ${s.expected}`));
  try {
    const result = await scorePullRequest({
      repoDir: worktree,
      baseSha,
      headSha,
      pr: { number: 0, title: s.title, body: s.body, author: 'sandbox', authorIsBot: false, baseRef: 'main', headSha },
      facts: { isFork: false, labels: [] },
      config,
      harness: createHarness(config.harness, config.harnessSettings, config.apiKey),
      readBaseFile: async (p) => git(repo, ['show', `${baseSha}:${p}`]),
      lock: true,
      log: (line) => console.log(styleText('dim', `  ${line}`)),
    });
    const got = result.mergeAllowed ? 'safe' : 'needs_human';
    const ok = got === s.expected;
    total++;
    if (ok) right++;
    const runCost = result.review?.costUsd ?? 0;
    cost += runCost;
    const agg = result.aggregate;
    const where = result.stoppedAt === 'ai' ? 'AI' : `gate: ${result.stoppedAt}`;
    rows.push(`| \`${s.branch}\` | ${s.expected} | ${got} | ${ok ? '✅' : '❌'} | ${where} | ${agg.risk ?? 'n/a'} | ${stars(agg.confidence)} | $${runCost.toFixed(4)} | ${s.why} |`);
    console.log(ok ? styleText('green', `  ${got} ✓`) : styleText('red', `  ${got} ✗`), styleText('dim', `$${runCost.toFixed(4)}`));
    const report = { result, mode: config.mode, action: 'none' as const, headSha, model: config.model };
    await writeFile(`eval/runs/${s.branch}.json`, JSON.stringify(verdictRecord(report, config, { number: 0, title: s.title }), null, 2));
  } finally {
    await git(repo, ['worktree', 'remove', '--force', worktree]);
  }
}
await rm(root, { recursive: true, force: true });

const table = [
  `# Sandbox eval`,
  '',
  `Harness: \`${config.harness}\` · model: \`${config.model}\` · ${new Date().toISOString().slice(0, 10)} · ${right} of ${total} as expected · total cost $${cost.toFixed(4)}`,
  '',
  '| Scenario | Expected | Got | | Decided by | Risk | Confidence | Cost | Why we expect it |',
  '|---|---|---|---|---|---|---|---|---|',
  ...rows,
  '',
  'Built by `scripts/make-sandbox.ts`, run by `scripts/eval-sandbox.ts`. Full records are in `eval/runs/` (not committed).',
  '',
].join('\n');
await writeFile('eval/results.md', table);
console.log(`\n${right} of ${total} as expected, total cost $${cost.toFixed(4)}. Written to eval/results.md`);
