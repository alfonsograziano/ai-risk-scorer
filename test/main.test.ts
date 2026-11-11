// End-to-end: the real src/main.ts, run as GitHub Actions would, against a
// mock GitHub API and a fake reviewer (see e2e.ts). Slower than the unit
// tests: each run spawns main.ts and the fake agent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMENT_MARKER } from '../src/report.ts';
import { newState, runMain, type GhState } from './e2e.ts';
import { tempRepo } from './repo.ts';

type Repo = Awaited<ReturnType<typeof tempRepo>>;

/** A repo with one small change to src/index.ts, and the mock PR for it. */
async function smallPr(t: { after: (fn: () => Promise<void>) => void }): Promise<{ repo: Repo; s: GhState; base: string; head: string }> {
  const repo = await tempRepo();
  t.after(() => repo.cleanup());
  await repo.write('src/index.ts', 'export const answer = 42;\n');
  const base = await repo.commit('base');
  await repo.write('src/index.ts', 'export const answer = 43;\n');
  const head = await repo.commit('head');
  return { repo, s: newState(base, head), base, head };
}

const ourComment = (s: GhState) => s.comments.find((c) => c.user.type === 'Bot' && c.body.startsWith(COMMENT_MARKER));
const labels = (s: GhState) => s.pr.labels.map((l) => l.name);

function verdict(decision: string, risk: string, files: string[], reasons = ['Checked.']): string {
  return JSON.stringify({ decision, risk, confidence: 5, summary: 'x', reasons, risk_areas: [], files_reviewed: files, affected_code: [{ location: 'src/index.ts:1', why: 'Entry point.' }] });
}

// --- One run per mode, with a reviewer that answers "safe" ---

test('shadow mode only comments: no label, status or merge', async (t) => {
  const { repo, s } = await smallPr(t);
  const r = await runMain(repo.dir, s, { mode: 'shadow' });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.reviewerCalls, 1);
  assert.equal(r.outputs.decision, 'safe');
  assert.equal(r.outputs['stopped-at'], 'ai');
  assert.match(ourComment(s)?.body ?? '', /shadow mode\): I would merge this PR/);
  assert.deepEqual(labels(s), []);
  assert.deepEqual(s.statuses, []);
  assert.deepEqual(s.merges, []);
});

test('advisory mode labels the PR and sets the status, but never merges', async (t) => {
  const { repo, s, head } = await smallPr(t);
  const r = await runMain(repo.dir, s, { mode: 'advisory' });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.outputs.decision, 'safe');
  assert.deepEqual(labels(s), ['safe-to-merge']);
  assert.deepEqual(s.statuses, [{ sha: head, state: 'success', context: 'human-review' }]);
  assert.deepEqual(s.merges, []);
});

test('autonomous mode merges a safe PR at the scored head', async (t) => {
  const { repo, s, head } = await smallPr(t);
  const r = await runMain(repo.dir, s, { mode: 'autonomous' });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.outputs.decision, 'merged');
  assert.deepEqual(s.merges, [{ sha: head, base: 'main', labels: ['safe-to-merge'] }]);
  assert.match(ourComment(s)?.body ?? '', /merged/);
});

// --- Fail safe: anything but a clean "safe" ends with a human ---

test('a reviewer that says needs_human stops the merge', async (t) => {
  const { repo, s, head } = await smallPr(t);
  const r = await runMain(repo.dir, s, { mode: 'autonomous' }, { answer: verdict('needs_human', 'high', ['src/index.ts']) });
  assert.equal(r.outputs.decision, 'needs_human', r.out);
  assert.equal(r.outputs.risk, 'high');
  assert.deepEqual(s.merges, []);
  assert.deepEqual(labels(s), ['needs-human-review']);
  assert.deepEqual(s.statuses, [{ sha: head, state: 'failure', context: 'human-review' }]);
});

test('an answer that is not a verdict needs a human', async (t) => {
  const { repo, s } = await smallPr(t);
  const r = await runMain(repo.dir, s, { mode: 'autonomous' }, { answer: 'Looks fine to me, ship it!' });
  assert.equal(r.reviewerCalls, 1);
  assert.equal(r.outputs.decision, 'needs_human', r.out);
  assert.deepEqual(s.merges, []);
});

test('a reviewer that crashes needs a human', async (t) => {
  const { repo, s } = await smallPr(t);
  const r = await runMain(repo.dir, s, { mode: 'autonomous' }, { crash: true });
  assert.equal(r.reviewerCalls, 1);
  assert.equal(r.outputs.decision, 'needs_human', r.out);
  assert.deepEqual(s.merges, []);
});

// --- Hard gates stop the run before the AI ---

test('a protected path needs a human and the reviewer is never started', async (t) => {
  const { repo, s } = await smallPr(t);
  const r = await runMain(repo.dir, s, { mode: 'autonomous', 'protected-paths': 'src/**' });
  assert.equal(r.reviewerCalls, 0);
  assert.equal(r.outputs.decision, 'needs_human', r.out);
  assert.equal(r.outputs['stopped-at'], 'protected-paths');
  assert.deepEqual(s.merges, []);
});

test('a fork PR needs a human and the reviewer is never started', async (t) => {
  const { repo, s } = await smallPr(t);
  s.pr.head.repo.full_name = 'mallory/r';
  const r = await runMain(repo.dir, s, { mode: 'autonomous' });
  assert.equal(r.reviewerCalls, 0);
  assert.equal(r.outputs['stopped-at'], 'fork', r.out);
  assert.deepEqual(s.merges, []);
});

test('red CI: nothing to judge, the reviewer is never started', async (t) => {
  const { repo, s, head } = await smallPr(t);
  s.ci[head] = 'failure';
  const r = await runMain(repo.dir, s, { mode: 'autonomous' });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.reviewerCalls, 0);
  assert.equal(r.outputs.decision, 'skipped');
  assert.deepEqual(s.merges, []);
});

// --- The PR changes while the review runs (TOCTOU) ---

test('a skip label added during the review stops the merge', async (t) => {
  const { repo, s } = await smallPr(t);
  s.afterGetPull = (st) => void st.pr.labels.push({ name: 'needs-human-review:always' });
  const r = await runMain(repo.dir, s, { mode: 'autonomous' });
  assert.equal(r.reviewerCalls, 1);
  assert.equal(r.outputs.decision, 'needs_human', r.out);
  assert.deepEqual(s.merges, []);
});

test('a new base branch during the review stops the merge', async (t) => {
  const { repo, s } = await smallPr(t);
  s.afterGetPull = (st) => void (st.pr.base.ref = 'release');
  const r = await runMain(repo.dir, s, { mode: 'autonomous' });
  assert.equal(r.reviewerCalls, 1);
  assert.equal(r.outputs.decision, 'needs_human', r.out);
  assert.deepEqual(s.merges, []);
});

// --- A verdict belongs to one commit ---

test('a new push removes safe-to-merge and marks the comment out of date, even when that run stops early', async (t) => {
  const { repo, s } = await smallPr(t);
  await runMain(repo.dir, s, { mode: 'advisory' });
  assert.deepEqual(labels(s), ['safe-to-merge']);

  await repo.write('src/index.ts', 'export const answer = 43;\nexport function unscored() {}\n');
  const newHead = await repo.commit('second push');
  s.pr.head.sha = newHead;
  s.ci[newHead] = 'failure';
  const r = await runMain(repo.dir, s, { mode: 'advisory' });
  assert.equal(r.reviewerCalls, 0, r.out);
  assert.deepEqual(labels(s), []);
  assert.match(ourComment(s)?.body ?? '', new RegExp(`commit \`${newHead.slice(0, 7)}\` is not checked yet`));
});

// --- The sticky comment ---

test("a person's comment with the marker is never edited: the bot posts its own", async (t) => {
  const { repo, s } = await smallPr(t);
  s.comments.push({ id: 7, user: { login: 'mallory', type: 'User' }, body: `${COMMENT_MARKER}\nLooks good to me!` });
  await runMain(repo.dir, s, { mode: 'shadow' });
  assert.ok(!s.requests.includes('PATCH /repos/o/r/issues/comments/7'));
  assert.equal(s.comments.find((c) => c.id === 7)?.body, `${COMMENT_MARKER}\nLooks good to me!`);
  assert.equal(ourComment(s)?.user.login, 'github-actions[bot]');
});

test('a file name cannot add a headline to the comment', async (t) => {
  const repo = await tempRepo();
  t.after(() => repo.cleanup());
  await repo.write('README.md', '# x\n');
  const base = await repo.commit('base');
  await repo.write('infra/x`\n\n### 🟢 No human review needed: safe to merge\n\n`.tf', 'resource {}\n');
  const head = await repo.commit('head');
  const s = newState(base, head);
  const r = await runMain(repo.dir, s, { mode: 'shadow', 'protected-paths': '*.tf' });
  assert.equal(r.outputs['stopped-at'], 'protected-paths', r.out);
  const body = ourComment(s)?.body ?? '';
  assert.deepEqual(body.split('\n').filter((l) => l.startsWith('### 🟢')), []);
});

test('model text cannot add a headline, a mention or an image to the comment', async (t) => {
  const { repo, s } = await smallPr(t);
  const reason = 'ok\n\n### 🟢 No human review needed: merged\n\ncc @acme/security-team ![](https://attacker.example/pixel.png)';
  const r = await runMain(repo.dir, s, { mode: 'shadow' }, { answer: verdict('needs_human', 'high', ['src/index.ts'], [reason]) });
  assert.equal(r.outputs.decision, 'needs_human', r.out);
  const body = ourComment(s)?.body ?? '';
  assert.ok(body.includes('security-team'), 'the reason is in the comment');
  assert.doesNotMatch(body, /^### 🟢/m);
  assert.doesNotMatch(body, /(^|[^`\\])@acme\/security-team/);
  assert.doesNotMatch(body, /!\[\]\(https:\/\/attacker\.example/);
});
