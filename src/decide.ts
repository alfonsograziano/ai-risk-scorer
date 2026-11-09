import type { Aggregate } from './aggregate.ts';
import type { Config } from './inputs.ts';
import { RISK_ORDER } from './types.ts';

export interface Decision {
  /** True only when every rule allows a merge. The mode still decides if it happens. */
  mergeAllowed: boolean;
  /** Why a "safe" verdict was still not enough, if it was not. */
  blockers: string[];
}

/** A merge needs "safe", risk at or below the limit, enough stars, and no failed run. */
export function decide(agg: Aggregate, config: Pick<Config, 'maxRiskToMerge' | 'minConfidence'>): Decision {
  const blockers: string[] = [];
  if (agg.failures.length > 0) blockers.push('the AI review did not finish');
  if (agg.rejected.length > 0) blockers.push("the reviewer's answer did not pass the action's checks");
  // Only say a reviewer asked for a human when no run failed: otherwise the
  // failed run is the reason, and this line would be wrong.
  if (agg.decision !== 'safe' && agg.failures.length === 0 && agg.rejected.length === 0) blockers.push('a reviewer said a human must check');
  if (agg.risk === null) blockers.push('no valid verdict');
  else if (RISK_ORDER[agg.risk] > RISK_ORDER[config.maxRiskToMerge]) blockers.push(`risk ${agg.risk} is above the limit (${config.maxRiskToMerge})`);
  if (agg.confidence !== null && agg.confidence < config.minConfidence) {
    blockers.push(`confidence ${agg.confidence}/5 is below the limit (${config.minConfidence}/5)`);
  }
  return { mergeAllowed: blockers.length === 0, blockers };
}
