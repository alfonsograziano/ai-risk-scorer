import type { Aggregate } from './aggregate.ts';
import { decide, type Decision } from './decide.ts';
import { runHardGates, type GateReport, type PrFacts } from './gates.ts';
import type { Harness } from './harness/types.ts';
import type { Config } from './inputs.ts';
import { code } from './markdown.ts';
import { loadSystemPrompt, type BaseFileReader, type PrMeta } from './prompt.ts';
import { runReview, type ReviewResult } from './review.ts';
import type { GateId } from './types.ts';
import { listChanges, lockWorkspace, prepareWorkspace, unlockWorkspace } from './workspace.ts';

export interface ScoreOptions {
  /** Checkout at the head SHA. */
  repoDir: string;
  baseSha: string;
  headSha: string;
  pr: PrMeta;
  facts: PrFacts;
  config: Config;
  harness: Harness;
  readBaseFile: BaseFileReader;
  /** Make the checkout read-only while the agent runs. */
  lock: boolean;
  log?: (line: string) => void;
}

export interface ScoreResult {
  mergeAllowed: boolean;
  /** The gate that stopped the run, "ai" when the AI step decided, or "error". */
  stoppedAt: GateId | 'ai' | 'error';
  gates: GateReport;
  aggregate: Aggregate;
  decision: Decision;
  review?: ReviewResult;
  filesChanged: number;
  slices: number;
}

function humanOnly(summary: string, reasons: string[]): Aggregate {
  return { decision: 'needs_human', risk: null, confidence: null, summary, reasons, riskAreas: [], affectedCode: [], failures: [], rejected: [] };
}

/**
 * The whole pipeline, without GitHub: hard gates, then the review workspace,
 * then the AI review, then the decision. Any error ends in "needs a human".
 */
export async function scorePullRequest(opts: ScoreOptions): Promise<ScoreResult> {
  const { config, log = () => undefined } = opts;
  const { files } = await listChanges(opts.repoDir, opts.baseSha, opts.headSha);
  const promptFiles = [config.systemPromptFile, config.customInstructionsFile].filter((f) => f !== '');
  const gates = runHardGates(files, opts.facts, config, promptFiles);
  log(`${files.length} files changed, gates: ${gates.results.map((g) => `${g.id}=${g.status}`).join(' ')}`);

  const stopped = (stoppedAt: ScoreResult['stoppedAt'], aggregate: Aggregate, extra: Partial<ScoreResult> = {}): ScoreResult => {
    const decision = decide(aggregate, config);
    return { mergeAllowed: false, stoppedAt, gates, aggregate, decision, filesChanged: files.length, slices: 0, ...extra };
  };

  if (gates.stoppedAt) {
    const gate = gates.results.find((g) => g.id === gates.stoppedAt);
    const reasons = [gate?.detail ?? 'A hard gate failed.', ...(gate?.files ?? []).slice(0, 20).map(code)];
    return stopped(gates.stoppedAt, humanOnly('A fixed rule sends this PR to a human. The AI was not asked.', reasons));
  }

  let systemPrompt: string;
  try {
    systemPrompt = await loadSystemPrompt(config, opts.readBaseFile);
  } catch (e) {
    return stopped('error', humanOnly('The action could not load its prompt.', [(e as Error).message]));
  }

  let ws;
  try {
    ws = await prepareWorkspace({
      repoDir: opts.repoDir,
      baseSha: opts.baseSha,
      headSha: opts.headSha,
      config,
      pr: { number: opts.pr.number, title: opts.pr.title, author: opts.pr.author, baseRef: opts.pr.baseRef },
    });
  } catch (e) {
    return stopped('error', humanOnly('The action could not prepare the review.', [(e as Error).message]));
  }
  log(`${ws.reviewFiles.length} files to review in ${ws.slices.length} slice(s), ${ws.generated.length} generated files set aside`);

  let review: ReviewResult;
  try {
    if (opts.lock) await lockWorkspace(opts.repoDir);
    review = await runReview({ ws, harness: opts.harness, systemPrompt, pr: opts.pr, gates: gates.results, config, log });
  } catch (e) {
    return stopped('error', humanOnly('The action failed during the review.', [(e as Error).message]), { slices: ws.slices.length });
  } finally {
    if (opts.lock) await unlockWorkspace(opts.repoDir);
  }

  const decision = decide(review.aggregate, config);
  return {
    mergeAllowed: decision.mergeAllowed,
    stoppedAt: 'ai',
    gates,
    aggregate: review.aggregate,
    decision,
    review,
    filesChanged: files.length,
    slices: ws.slices.length,
  };
}
