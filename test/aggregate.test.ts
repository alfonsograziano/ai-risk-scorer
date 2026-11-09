import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, type RunOutcome } from '../src/aggregate.ts';
import type { Verdict } from '../src/types.ts';

function run(label: string, v: Partial<Verdict> = {}): RunOutcome {
  return {
    label,
    ok: true,
    verdict: {
      decision: 'safe',
      risk: 'low',
      confidence: 5,
      summary: `summary ${label}`,
      reasons: [`reason ${label}`],
      risk_areas: [],
      files_reviewed: [],
      affected_code: [],
      ...v,
    },
  };
}

test('all safe is safe', () => {
  const a = aggregate([run('slice 1'), run('slice 2'), run('integrator')]);
  assert.equal(a.decision, 'safe');
  assert.equal(a.risk, 'low');
  assert.equal(a.summary, 'summary integrator');
});

test('nine safe slices and one no is a no', () => {
  const runs = Array.from({ length: 9 }, (_, i) => run(`slice ${i + 1}`));
  runs.push(run('slice 10', { decision: 'needs_human', risk: 'high', confidence: 4, reasons: ['token refresh changed'] }));
  const a = aggregate(runs);
  assert.equal(a.decision, 'needs_human');
  assert.equal(a.risk, 'high');
  assert.deepEqual(a.reasons, ['[slice 10] token refresh changed']);
});

test('the lowest confidence wins', () => {
  assert.equal(aggregate([run('a', { confidence: 5 }), run('b', { confidence: 3 })]).confidence, 3);
});

test('any failed run is a no, even if every other run said safe', () => {
  const a = aggregate([run('slice 1'), { label: 'slice 2', ok: false, error: 'timeout' }]);
  assert.equal(a.decision, 'needs_human');
  assert.deepEqual(a.failures, ['slice 2: timeout']);
});

test('no valid runs at all has no risk and needs a human', () => {
  const a = aggregate([{ label: 'slice 1', ok: false, error: 'crash' }]);
  assert.equal(a.decision, 'needs_human');
  assert.equal(a.risk, null);
});

test('a rejected answer is kept apart from a run that did not finish', () => {
  const a = aggregate([{ label: 'review', ok: false, error: 'no proof of the impact pass', rejected: true }]);
  assert.equal(a.decision, 'needs_human');
  assert.deepEqual(a.failures, []);
  assert.deepEqual(a.rejected, ['review: no proof of the impact pass']);
  assert.ok(a.summary.startsWith('The reviewer answered'));
});

test('a rejected answer is a no, even if every other run said safe', () => {
  const a = aggregate([run('slice 1'), { label: 'slice 2', ok: false, error: 'bad JSON', rejected: true }]);
  assert.equal(a.decision, 'needs_human');
});
