import type { Config } from './inputs.ts';
import { code, inline } from './markdown.ts';
import type { ScoreResult } from './score.ts';
import type { Mode } from './types.ts';

export const COMMENT_MARKER = '<!-- needs-human-review -->';

/** What the action did with the result. */
export type Action = 'merged' | 'merge-blocked' | 'labelled' | 'none';

export interface ReportInput {
  result: ScoreResult;
  mode: Mode;
  action: Action;
  headSha: string;
  /** Why GitHub refused the merge, when it did. */
  mergeError?: string;
  model: string;
}

export function stars(n: number | null): string {
  if (n === null) return 'n/a';
  return `${'★'.repeat(n)}${'☆'.repeat(5 - n)} ${n}/5`;
}

const GATE_NAMES: Record<string, string> = {
  fork: 'not a fork',
  'skip-label': 'no skip label',
  'self-protected': 'no self-protected files',
  'special-files': 'no symlinks or unreadable binaries',
  lockfiles: 'no lock files',
  'protected-paths': 'no protected paths',
  size: 'size',
};

function headline(r: ReportInput): string {
  const safe = r.result.mergeAllowed;
  if (r.mode === 'shadow') return safe ? '🟢 No human review needed (shadow mode): I would merge this PR' : '🔴 Human review required (shadow mode): I would ask a human to review this PR';
  if (!safe) return '🔴 Human review required';
  if (r.action === 'merged') return '🟢 No human review needed: merged';
  if (r.action === 'merge-blocked') return '🟡 No human review needed, but I could not merge it';
  return '🟢 No human review needed: safe to merge';
}

function gateLine(result: ScoreResult): string {
  const icon = (s: string) => (s === 'pass' ? '✅' : s === 'fail' ? '❌' : '⏭️');
  const ci = '✅ CI green';
  const rest = result.gates.results.map((g) => (g.id === 'size' && g.status !== 'off' ? `${icon(g.status)} size: ${inline(g.detail)}` : `${icon(g.status)} ${g.status === 'off' ? `${GATE_NAMES[g.id]} off` : GATE_NAMES[g.id]}`));
  return [ci, ...rest].join(' · ');
}

/** The sticky PR comment. Also used as the job summary. */
export function renderReport(r: ReportInput): string {
  const { result } = r;
  const agg = result.aggregate;
  const lines: string[] = [COMMENT_MARKER, `### ${headline(r)}`, ''];
  lines.push(`**Risk:** ${agg.risk ?? 'n/a'} · **Confidence:** ${stars(agg.confidence)} · **Mode:** ${r.mode} · **Commit:** \`${r.headSha.slice(0, 7)}\``, '');
  if (r.mode === 'shadow') lines.push('> Shadow mode: no action taken. This is what the action would have done.', '');
  // Everything below that comes from the model or the PR is untrusted text.
  lines.push(inline(agg.summary, 300), '');

  const why = result.mergeAllowed ? (r.action === 'merged' ? 'Why I merged it' : 'Why it is safe') : 'Why this needs a human';
  lines.push(`**${why}**`);
  for (const reason of agg.reasons) lines.push(`- ${inline(reason)}`);
  if (!result.mergeAllowed && result.stoppedAt === 'ai') {
    for (const b of result.decision.blockers) if (!agg.reasons.includes(b)) lines.push(`- Rule: ${inline(b)}.`);
  }
  for (const f of agg.failures) lines.push(`- The review could not finish: ${inline(f)}`);
  if (r.action === 'merge-blocked' && r.mergeError) lines.push(`- GitHub refused the merge: ${inline(r.mergeError)}`);
  lines.push('');

  if (agg.affectedCode.length > 0) {
    lines.push('<details><summary>Code outside the diff that was checked</summary>', '');
    for (const a of agg.affectedCode.slice(0, 30)) lines.push(`- ${code(a.location.slice(0, 200))}: ${inline(a.why, 300)}`);
    lines.push('', '</details>', '');
  }

  lines.push('<details><summary>Gates and run details</summary>', '', gateLine(result), '');
  if (result.review) {
    const cost = result.review.costUsd;
    lines.push(`${result.filesChanged} files changed · ${result.slices} slice(s) · ${result.review.runs.length} reviewer run(s) · model ${code(r.model)}${cost > 0 ? ` · cost $${cost.toFixed(4)}` : ''}`);
  } else {
    lines.push(`${result.filesChanged} files changed · stopped at \`${result.stoppedAt}\` before any AI call`);
  }
  lines.push('', '</details>');
  return lines.join('\n');
}

/** The verdict record kept as an artifact: the raw material for a later override log. */
export function verdictRecord(r: ReportInput, config: Config, pr: { number: number; title: string }): Record<string, unknown> {
  return {
    version: 1,
    at: new Date().toISOString(),
    pr: { number: pr.number, title: pr.title },
    headSha: r.headSha,
    mode: r.mode,
    model: config.model,
    harness: config.harness,
    harnessSettings: config.harnessSettings,
    mergeAllowed: r.result.mergeAllowed,
    action: r.action,
    stoppedAt: r.result.stoppedAt,
    gates: r.result.gates.results,
    aggregate: r.result.aggregate,
    blockers: r.result.decision.blockers,
    runs: r.result.review?.runs.map((x) => ({ ...x, raw: x.raw?.slice(-200_000) })) ?? [],
    costUsd: r.result.review?.costUsd ?? 0,
  };
}
