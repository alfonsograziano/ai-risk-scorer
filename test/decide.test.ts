import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Aggregate } from '../src/aggregate.ts';
import { decide } from '../src/decide.ts';
import { renderReport, stars } from '../src/report.ts';
import type { ScoreResult } from '../src/score.ts';
import { testConfig } from './helpers.ts';

const safe: Aggregate = {
  decision: 'safe',
  risk: 'low',
  confidence: 5,
  summary: 'Docs only.',
  reasons: ['Only the README changes.'],
  riskAreas: [],
  affectedCode: [],
  failures: [],
  rejected: [],
};

test('safe, low risk and enough stars may merge', () => {
  assert.deepEqual(decide(safe, testConfig()), { mergeAllowed: true, blockers: [] });
});

test('medium risk only merges when the team allows it', () => {
  const medium = { ...safe, risk: 'medium' as const };
  assert.equal(decide(medium, testConfig()).mergeAllowed, false);
  assert.equal(decide(medium, testConfig({ maxRiskToMerge: 'medium' })).mergeAllowed, true);
});

test('too few stars blocks a merge, even when the verdict is safe', () => {
  const d = decide({ ...safe, confidence: 3 }, testConfig());
  assert.equal(d.mergeAllowed, false);
  assert.ok(d.blockers[0]?.includes('3/5'));
});

test('any failure blocks a merge', () => {
  assert.equal(decide({ ...safe, failures: ['slice 2: timeout'] }, testConfig()).mergeAllowed, false);
});

function result(agg: Aggregate, mergeAllowed: boolean): ScoreResult {
  return {
    mergeAllowed,
    stoppedAt: 'ai',
    gates: { results: [{ id: 'size', status: 'off', detail: 'off' }] },
    aggregate: agg,
    decision: decide(agg, testConfig()),
    filesChanged: 1,
    slices: 1,
  };
}

test('the report says shadow mode took no action', () => {
  const md = renderReport({ result: result(safe, true), mode: 'shadow', action: 'none', headSha: 'abcdef1234', model: 'm' });
  assert.ok(md.startsWith('<!-- needs-human-review -->'));
  assert.ok(md.includes('### 🟢 No human review needed (shadow mode): I would merge this PR'));
  assert.ok(md.includes('no action taken'));
  assert.ok(md.includes('★★★★★ 5/5'));
});

test('the report explains a blocked merge', () => {
  const md = renderReport({ result: result(safe, true), mode: 'autonomous', action: 'merge-blocked', mergeError: 'review required', headSha: 'abc', model: 'm' });
  assert.ok(md.includes('### 🟡 No human review needed, but I could not merge it'));
  assert.ok(md.includes('review required'));
});

test('stars render as a five-star bar', () => {
  assert.equal(stars(2), '★★☆☆☆ 2/5');
  assert.equal(stars(null), 'n/a');
});

test('a rejected answer blocks a merge, and the comment does not say a reviewer asked for a human', () => {
  const agg: Aggregate = { ...safe, decision: 'needs_human', risk: null, confidence: null, rejected: ['review: no proof of the impact pass'] };
  const d = decide(agg, testConfig());
  assert.equal(d.mergeAllowed, false);
  assert.ok(d.blockers.includes("the reviewer's answer did not pass the action's checks"));
  assert.ok(!d.blockers.includes('a reviewer said a human must check'));
  assert.ok(!d.blockers.includes('the AI review did not finish'));
  const md = renderReport({ result: { ...result(agg, false), decision: d }, mode: 'shadow', action: 'none', headSha: 'abc', model: 'm' });
  assert.ok(md.includes('- The answer was rejected: review: no proof of the impact pass'));
  assert.ok(!md.includes('could not finish'));
});
