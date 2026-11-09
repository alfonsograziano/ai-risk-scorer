// Entry point for GitHub Actions. Run by action.yml as `node src/main.ts`.
import { randomBytes } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changesSinceScored, resolveContext, type WorkflowRunEvent } from './context.ts';
import { moveCredentialFilesOut } from './credentials.ts';
import { ciState, waitForCi } from './gates.ts';
import { GitHub } from './github.ts';
import { createHarness } from './harness/create.ts';
import { ConfigError, readConfig, type Config } from './inputs.ts';
import { COMMENT_MARKER, renderReport, verdictRecord, type Action, type ReportInput } from './report.ts';
import { scorePullRequest } from './score.ts';
import { baseFileReader } from './workspace.ts';

export const STATUS_CONTEXT = 'human-review';
export const LABEL_SAFE = 'safe-to-merge';
export const LABEL_HUMAN = 'needs-human-review';

const env = process.env;
const log = (line: string) => console.log(line);

async function setOutputs(values: Record<string, string>): Promise<void> {
  if (!env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values).map(([k, v]) => `${k}<<__ARS__\n${v}\n__ARS__\n`);
  await appendFile(env.GITHUB_OUTPUT, lines.join(''));
}

async function summary(markdown: string): Promise<void> {
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

async function skip(reason: string): Promise<void> {
  log(`Nothing to do: ${reason}.`);
  await summary(`Needs Human Review: nothing to do, ${reason}.`);
  await setOutputs({ decision: 'skipped', 'stopped-at': 'skipped', risk: '', confidence: '', 'verdict-json': '', 'record-path': '', 'record-name': '' });
}

async function run(config: Config): Promise<void> {
  const repo = env.GITHUB_REPOSITORY ?? '';
  const gh = new GitHub(config.githubToken || env.GITHUB_TOKEN || '', repo, env.GITHUB_API_URL);
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH ?? '', 'utf8')) as WorkflowRunEvent;

  const ctx = await resolveContext(gh, env.GITHUB_EVENT_NAME ?? '', event, config.baseBranches);
  if ('skip' in ctx) return skip(ctx.skip);
  const { pr, meta, facts, baseSha, headSha, allowedBases } = ctx;
  log(`PR #${pr.number} (head ${headSha.slice(0, 7)})`);

  // A verdict belongs to one commit. This is a new run, so whatever an earlier
  // run said no longer applies, even if this run stops early (red CI, pending
  // checks). The commit status is per commit already; the label and comment are not.
  if (config.mode !== 'shadow') await gh.removeLabel(pr.number, LABEL_SAFE);
  if (config.comment) {
    await gh.updateComment(
      pr.number,
      COMMENT_MARKER,
      `${COMMENT_MARKER}\n### ⏳ Needs Human Review: commit \`${headSha.slice(0, 7)}\` is not checked yet\n\nThe earlier verdict was for an older commit and no longer applies.`,
    );
  }

  // G1: every other check on the head commit must be green.
  const ownSuite = env.GITHUB_RUN_ID ? await gh.checkSuiteOfRun(env.GITHUB_RUN_ID) : undefined;
  const readCi = async () => ciState(await gh.checksFor(headSha, ownSuite, [STATUS_CONTEXT]), [], config.requiredChecks);
  let ci = await readCi();
  if (ci.state === 'pending') {
    log(`Waiting up to ${config.ciWaitMinutes} minutes for: ${ci.names.join(', ')}`);
    ci = await waitForCi(readCi, config.ciWaitMinutes * 60_000);
  }
  if (ci.state === 'pending') {
    // Nothing will trigger us again for a GitHub App check, so say so instead of going quiet.
    const names = ci.names.join(', ');
    if (config.comment) {
      await gh.upsertComment(
        pr.number,
        COMMENT_MARKER,
        `${COMMENT_MARKER}\n### 🔴 Human review required\n\nThese checks were still running after ${config.ciWaitMinutes} minutes: ${names}. Needs Human Review only judges PRs whose CI is green, so it did not review this one. Re-run the Needs Human Review workflow once they finish.`,
      );
    }
    return skip(`CI was still pending after ${config.ciWaitMinutes} minutes (${names})`);
  }
  if (ci.state !== 'green') return skip(`CI is ${ci.state} on ${headSha.slice(0, 7)} (${ci.names.join(', ')})`);

  const repoDir = env.GITHUB_WORKSPACE ?? process.cwd();
  // Before the checkout is locked: a cloud sign-in step may have left a credentials file in it.
  const moved = await moveCredentialFilesOut(repoDir, env.RUNNER_TEMP ?? tmpdir(), process.env);
  if (moved.length > 0) console.log(`Moved ${moved.join(', ')} out of the checkout, so the reviewer cannot read it.`);
  const harness = createHarness(config.harness, config.harnessSettings, config.apiKey);
  const result = await scorePullRequest({
    repoDir,
    baseSha,
    headSha,
    pr: meta,
    facts,
    config,
    harness,
    readBaseFile: baseFileReader(repoDir, baseSha),
    lock: true,
    log,
  });

  // The review took minutes. Before acting, check that nothing which would
  // have stopped the run happened meanwhile: a skip label, a new base branch...
  if (result.mergeAllowed && config.mode !== 'shadow') {
    const changes = changesSinceScored(pr, await gh.getPull(pr.number), allowedBases, config.skipLabel);
    if (changes.length > 0) {
      result.mergeAllowed = false;
      result.decision.mergeAllowed = false;
      result.decision.blockers.push(...changes.map((c) => `the PR changed during the review: ${c}`));
    }
  }

  // Act by mode. Shadow only writes things down.
  let action: Action = 'none';
  let mergeError: string | undefined;
  if (config.mode !== 'shadow') {
    await gh.setLabel(pr.number, result.mergeAllowed ? LABEL_SAFE : LABEL_HUMAN, [result.mergeAllowed ? LABEL_HUMAN : LABEL_SAFE]);
    await gh.setStatus(headSha, result.mergeAllowed ? 'success' : 'failure', STATUS_CONTEXT, result.mergeAllowed ? `Not needed: safe to merge (risk ${result.aggregate.risk})` : 'Required: a human must review this PR');
    action = 'labelled';
  }
  if (config.mode === 'autonomous' && result.mergeAllowed) {
    try {
      await gh.merge(pr.number, headSha, config.mergeMethod, pr.title);
      action = 'merged';
    } catch (e) {
      action = 'merge-blocked';
      mergeError = (e as Error).message.replace(/^PUT \S+: /, '');
    }
  }

  const report: ReportInput = { result, mode: config.mode, action, headSha, model: config.model, ...(mergeError ? { mergeError } : {}) };
  const markdown = renderReport(report);
  if (config.comment) await gh.upsertComment(pr.number, COMMENT_MARKER, markdown);
  await summary(markdown);

  // Unique per run of the action, so two runs in one workflow run (a matrix over harnesses, say) never share a file or an artifact name.
  const recordName = `needs-human-review-verdict-pr${pr.number}-${headSha.slice(0, 7)}-${randomBytes(4).toString('hex')}`;
  const recordPath = join(env.RUNNER_TEMP ?? repoDir, `${recordName}.json`);
  await writeFile(recordPath, JSON.stringify(verdictRecord(report, config, { number: pr.number, title: pr.title }), null, 2));
  await setOutputs({
    decision: action === 'merged' ? 'merged' : result.mergeAllowed ? 'safe' : 'needs_human',
    risk: result.aggregate.risk ?? '',
    confidence: result.aggregate.confidence === null ? '' : String(result.aggregate.confidence),
    'stopped-at': result.stoppedAt,
    'verdict-json': JSON.stringify(result.aggregate),
    'record-path': recordPath,
    'record-name': recordName,
  });
  log(`Done: ${action === 'merged' ? 'merged' : result.mergeAllowed ? 'safe' : 'needs a human'} (stopped at ${result.stoppedAt}).`);
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = readConfig(env);
  } catch (e) {
    const message = e instanceof ConfigError ? e.message : String(e);
    console.error(message);
    await summary(`### 🔴 Needs Human Review: bad config\n\n${message}`);
    process.exitCode = 1;
    return;
  }
  try {
    await run(config);
  } catch (e) {
    // Never merge on an error. The job fails so the team sees it; no merge has happened.
    console.error(`Needs Human Review failed, so a human must review this PR: ${(e as Error).stack ?? e}`);
    await summary(`### 🔴 Needs Human Review failed\n\nA human must review this PR.\n\n\`\`\`\n${(e as Error).message}\n\`\`\``);
    process.exitCode = 1;
  }
}

await main();
