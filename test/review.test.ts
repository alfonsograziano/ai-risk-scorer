import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeHarness, type FakeAnswer } from '../src/harness/fake.ts';
import type { HarnessInput } from '../src/harness/types.ts';
import { runReview } from '../src/review.ts';
import type { Slice } from '../src/slices.ts';
import type { FileRead } from '../src/types.ts';
import { prepareWorkspace, type Workspace } from '../src/workspace.ts';
import { testConfig } from './helpers.ts';
import { tempRepo } from './repo.ts';

const pr = { number: 1, title: 't', body: 'b', author: 'a', authorIsBot: false, baseRef: 'main', headSha: '' };

async function bigRepo(files: number) {
  const repo = await tempRepo();
  const body = (i: number, v: string) => `export function f${i}() {\n${'  const a = 1;\n'.repeat(60)}  return '${v}';\n}\n`;
  for (let i = 0; i < files; i++) await repo.write(`src/f${String(i).padStart(2, '0')}.ts`, body(i, 'old'));
  const base = await repo.commit('base');
  for (let i = 0; i < files; i++) await repo.write(`src/f${String(i).padStart(2, '0')}.ts`, body(i, 'new'));
  const head = await repo.commit('head');
  return { repo, base, head };
}

/** Which slice a message is for, and the reads a diligent reviewer would make. */
async function sliceFor(ws: Workspace, input: HarnessInput): Promise<{ slice?: Slice; reads: FileRead[] }> {
  const m = /slices\/(\d+)\.json/.exec(input.userMessage);
  if (!m) return { reads: [] };
  const slice = ws.slices[Number(m[1]) - 1];
  const json = JSON.parse(await readFile(join(ws.repoDir, ws.reviewDir, 'slices', `${m[1]}.json`), 'utf8')) as { items: { mustRead: FileRead[] }[] };
  return { slice, reads: json.items.flatMap((i) => i.mustRead.map((r) => ({ path: r.path }))) };
}

function verdict(files: string[], decision = 'safe', risk = 'low'): string {
  return JSON.stringify({
    decision,
    risk,
    confidence: 5,
    summary: 'Changes return values.',
    reasons: ['Only a string literal changes.'],
    risk_areas: [],
    files_reviewed: files,
    affected_code: [{ location: 'src/x.ts:1', why: 'Calls it.' }],
  });
}

test('a small PR gets one review and no integrator', async () => {
  const { repo, base, head } = await bigRepo(2);
  try {
    const ws = await prepareWorkspace({ repoDir: repo.dir, baseSha: base, headSha: head, config: testConfig(), pr: {} });
    const harness = new FakeHarness(async (input): Promise<FakeAnswer> => {
      const { slice, reads } = await sliceFor(ws, input);
      return { finalText: verdict(slice?.items.map((i) => i.path) ?? []), reads };
    });
    const r = await runReview({ ws, harness, systemPrompt: 'S', pr, gates: [], config: testConfig() });
    assert.equal(harness.calls.length, 1);
    assert.equal(r.aggregate.decision, 'safe');
  } finally {
    await repo.cleanup();
  }
});

test('a big PR is sliced, every slice reviewed, then the integrator', async () => {
  const { repo, base, head } = await bigRepo(8);
  try {
    const config = testConfig({ sliceMaxTokens: 2_000 });
    const ws = await prepareWorkspace({ repoDir: repo.dir, baseSha: base, headSha: head, config, pr: {} });
    assert.ok(ws.slices.length > 2);
    const harness = new FakeHarness(async (input): Promise<FakeAnswer> => {
      const { slice, reads } = await sliceFor(ws, input);
      return { finalText: verdict(slice ? slice.items.map((i) => i.path) : []), reads };
    });
    const r = await runReview({ ws, harness, systemPrompt: 'S', pr, gates: [], config });
    assert.equal(harness.calls.length, ws.slices.length + 1);
    assert.ok(harness.calls.at(-1)?.userMessage.includes('integrator'));
    assert.equal(r.aggregate.decision, 'safe');
  } finally {
    await repo.cleanup();
  }
});

test('one risky slice among safe ones means a human, and stops early', async () => {
  const { repo, base, head } = await bigRepo(8);
  try {
    const config = testConfig({ sliceMaxTokens: 2_000, maxParallel: 1 });
    const ws = await prepareWorkspace({ repoDir: repo.dir, baseSha: base, headSha: head, config, pr: {} });
    const harness = new FakeHarness(async (input, call): Promise<FakeAnswer> => {
      const { slice, reads } = await sliceFor(ws, input);
      const files = slice?.items.map((i) => i.path) ?? [];
      return { finalText: call === 2 ? verdict(files, 'needs_human', 'high') : verdict(files), reads };
    });
    const r = await runReview({ ws, harness, systemPrompt: 'S', pr, gates: [], config });
    assert.equal(r.aggregate.decision, 'needs_human');
    assert.equal(r.aggregate.risk, 'high');
    assert.equal(harness.calls.length, 2, 'no more slices and no integrator after a no');
  } finally {
    await repo.cleanup();
  }
});

test('a reviewer that skipped reading a file is not trusted', async () => {
  const { repo, base, head } = await bigRepo(2);
  try {
    const ws = await prepareWorkspace({ repoDir: repo.dir, baseSha: base, headSha: head, config: testConfig(), pr: {} });
    const harness = new FakeHarness(async (input): Promise<FakeAnswer> => {
      const { slice, reads } = await sliceFor(ws, input);
      return { finalText: verdict(slice?.items.map((i) => i.path) ?? []), reads: reads.filter((r) => !r.path.endsWith('f01.ts')) };
    });
    const r = await runReview({ ws, harness, systemPrompt: 'S', pr, gates: [], config: testConfig() });
    assert.equal(r.aggregate.decision, 'needs_human');
    assert.ok(r.aggregate.rejected[0]?.includes('src/f01.ts'));
    assert.deepEqual(r.aggregate.failures, []);
  } finally {
    await repo.cleanup();
  }
});

test('a crash, a timeout or bad JSON all mean a human', async () => {
  const { repo, base, head } = await bigRepo(1);
  try {
    const ws = await prepareWorkspace({ repoDir: repo.dir, baseSha: base, headSha: head, config: testConfig(), pr: {} });
    const cases = [
      { answer: { error: 'timed out after 10 minutes' }, failures: 1, rejected: 0 },
      { answer: { finalText: 'Looks good to me!', reads: [] }, failures: 0, rejected: 1 },
    ];
    for (const c of cases) {
      const r = await runReview({ ws, harness: new FakeHarness(() => c.answer), systemPrompt: 'S', pr, gates: [], config: testConfig() });
      assert.equal(r.aggregate.decision, 'needs_human');
      assert.equal(r.aggregate.failures.length, c.failures);
      assert.equal(r.aggregate.rejected.length, c.rejected);
    }
  } finally {
    await repo.cleanup();
  }
});

test('too many slices hits the cost cap without calling the model', async () => {
  const { repo, base, head } = await bigRepo(6);
  try {
    const config = testConfig({ sliceMaxTokens: 2_000, maxSlices: 1 });
    const ws = await prepareWorkspace({ repoDir: repo.dir, baseSha: base, headSha: head, config, pr: {} });
    assert.ok(ws.slices.length > 1);
    const harness = new FakeHarness(() => ({ error: 'should not be called' }));
    const r = await runReview({ ws, harness, systemPrompt: 'S', pr, gates: [], config });
    assert.equal(harness.calls.length, 0);
    assert.equal(r.skipped, 'max-slices');
    assert.equal(r.aggregate.decision, 'needs_human');
  } finally {
    await repo.cleanup();
  }
});
