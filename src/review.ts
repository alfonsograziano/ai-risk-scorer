import { aggregate, type Aggregate, type RunOutcome } from './aggregate.ts';
import { isDocOrTest } from './globs.ts';
import { code } from './markdown.ts';
import type { Harness, HarnessResult } from './harness/types.ts';
import type { Config } from './inputs.ts';
import { integratorMessage, sliceMessage, type PrMeta, type SliceSummary } from './prompt.ts';
import { describeRequirement, missingReads } from './reading.ts';
import type { GateResult } from './types.ts';
import { parseVerdict } from './verdict.ts';
import { MAX_LINE_CHARS, type Workspace } from './workspace.ts';

export interface RunLog {
  label: string;
  ok: boolean;
  error?: string;
  durationMs?: number;
  costUsd?: number;
  reads?: number;
  finalText?: string;
  raw?: string;
}

export interface ReviewResult {
  aggregate: Aggregate;
  runs: RunLog[];
  /** Set when the AI step did not run at all, with the reason. */
  skipped?: string;
  costUsd: number;
}

export interface ReviewOptions {
  ws: Workspace;
  harness: Harness;
  systemPrompt: string;
  pr: PrMeta;
  gates: GateResult[];
  config: Config;
  log?: (line: string) => void;
}

function humanOnly(reason: string): Aggregate {
  return { decision: 'needs_human', risk: null, confidence: null, summary: reason, reasons: [reason], riskAreas: [], affectedCode: [], failures: [], rejected: [] };
}

/**
 * Runs one reviewer per slice, then the integrator when there is more than
 * one slice, and adds the verdicts up in code. Stops launching new slices as
 * soon as one says "needs_human", since the answer can no longer be "safe".
 */
export async function runReview(opts: ReviewOptions): Promise<ReviewResult> {
  const { ws, harness, config, pr, gates } = opts;
  const log = opts.log ?? (() => undefined);
  const total = ws.slices.length;

  if (total === 0) {
    return { aggregate: humanOnly('The PR has no file the AI can review, so a human must check it.'), runs: [], skipped: 'no reviewable files', costUsd: 0 };
  }
  if (ws.longLines.length > 0) {
    const shown = ws.longLines.slice(0, 10).map(code).join(', ');
    return {
      aggregate: humanOnly(`Some changed lines are longer than ${MAX_LINE_CHARS} characters, so the reviewer could not read them in full: ${shown}${ws.longLines.length > 10 ? ', …' : ''}.`),
      runs: [],
      skipped: 'long lines',
      costUsd: 0,
    };
  }
  if (config.maxSlices > 0 && total > config.maxSlices) {
    return { aggregate: humanOnly(`Too big to review within the cost limit: ${total} slices, the limit is ${config.maxSlices}.`), runs: [], skipped: 'max-slices', costUsd: 0 };
  }

  const deadline = Date.now() + config.timeoutMinutes * 60_000;
  const timeoutFor = () => Math.max(1_000, Math.min(config.sliceTimeoutMinutes * 60_000, deadline - Date.now()));
  const outcomes: RunOutcome[] = [];
  const logs: RunLog[] = [];
  let stop = false;

  const runOne = async (label: string, userMessage: string, check: (r: HarnessResult) => RunOutcome): Promise<RunOutcome> => {
    if (Date.now() >= deadline) return { label, ok: false, error: `the AI step ran out of time (${config.timeoutMinutes} minutes)` };
    log(`${label}: reviewing`);
    let result: HarnessResult;
    try {
      result = await harness.run({ systemPrompt: opts.systemPrompt, userMessage, workdir: ws.repoDir, model: config.model, timeoutMs: timeoutFor() });
    } catch (e) {
      const error = (e as Error).message;
      logs.push({ label, ok: false, error, raw: (e as { raw?: string }).raw ?? '' });
      log(`${label}: failed, ${error}`);
      return { label, ok: false, error };
    }
    const checked = check(result);
    const outcome: RunOutcome = checked.ok ? checked : { ...checked, rejected: true };
    logs.push({
      label,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { error: outcome.error }),
      durationMs: result.durationMs,
      costUsd: result.costUsd ?? 0,
      reads: result.reads.length,
      finalText: result.finalText,
      raw: result.raw,
    });
    log(`${label}: ${outcome.ok ? `${outcome.verdict.decision}, risk ${outcome.verdict.risk}, ${outcome.verdict.confidence}/5` : `invalid, ${outcome.error}`}`);
    return outcome;
  };

  const sliceTask = async (index: number): Promise<void> => {
    const slice = ws.slices[index];
    if (!slice || stop) return;
    const label = total === 1 ? 'review' : `slice ${slice.index}`;
    const files = [...new Set(slice.items.map((i) => i.path))];
    const outcome = await runOne(label, sliceMessage(pr, gates, ws.reviewDir, slice.index, total), (r) => {
      const parsed = parseVerdict(r.finalText, { role: 'slice', sliceFiles: files, runtimeChanged: files.some((f) => !isDocOrTest(f)) });
      if (!parsed.ok) return { label, ok: false, error: parsed.error };
      const missing = missingReads(slice.items.flatMap((i) => i.mustRead), r.reads);
      if (missing.length > 0) return { label, ok: false, error: `the tool-call log shows these were not read: ${missing.map(describeRequirement).join(', ')}` };
      return { label, ok: true, verdict: parsed.verdict };
    });
    outcomes[index] = outcome;
    if (!outcome.ok || outcome.verdict.decision === 'needs_human') stop = true;
  };

  let next = 0;
  const workers = Array.from({ length: Math.min(config.maxParallel, total) }, async () => {
    while (next < total && !stop) await sliceTask(next++);
  });
  await Promise.all(workers);
  const done = outcomes.filter(Boolean);
  if (done.length < total) log(`stopped after ${done.length} of ${total} slices: the answer is already "needs a human"`);

  if (total > 1 && !stop) {
    const summaries: SliceSummary[] = ws.slices.map((s, i) => {
      const o = outcomes[i];
      return { slice: s.index, files: [...new Set(s.items.map((x) => x.path))], verdict: o?.ok ? JSON.stringify(o.verdict, null, 2) : 'missing' };
    });
    const runtime = ws.files.some((f) => !isDocOrTest(f.path));
    done.push(
      await runOne('integrator', integratorMessage(pr, gates, ws.reviewDir, summaries), (r) => {
        const parsed = parseVerdict(r.finalText, { role: 'integrator', sliceFiles: [], runtimeChanged: runtime });
        return parsed.ok ? { label: 'integrator', ok: true, verdict: parsed.verdict } : { label: 'integrator', ok: false, error: parsed.error };
      }),
    );
  }

  const costUsd = logs.reduce((sum, l) => sum + (l.costUsd ?? 0), 0);
  return { aggregate: aggregate(done), runs: logs, costUsd };
}
