import type { Verdict } from './types.ts';

export type ParseResult = { ok: true; verdict: Verdict } | { ok: false; error: string };

const KEYS = ['decision', 'risk', 'confidence', 'summary', 'reasons', 'risk_areas', 'files_reviewed', 'affected_code'] as const;

interface Found {
  value: unknown;
  start: number;
  end: number;
}

/** Every top-level `{...}` in the text, found with a brace matcher that respects strings. */
function jsonObjects(text: string): Found[] {
  const found: Found[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            found.push({ value: JSON.parse(text.slice(start, i + 1)), start, end: i + 1 });
            start = i;
          } catch {
            // Not JSON; try the next brace.
          }
          break;
        }
      }
    }
  }
  return found;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export interface VerdictRules {
  role: 'slice' | 'integrator';
  /** Files the slice reviewer must list in files_reviewed. */
  sliceFiles: string[];
  /** True when the reviewed files include code that runs, not only docs or tests. */
  runtimeChanged: boolean;
}

/**
 * Finds the verdict in the final message and checks it strictly. The verdict
 * must be the only JSON object with a "decision" field, it must end the message
 * (a closing code fence is fine), and "decision" must not appear before it.
 * Anything else is ambiguous: the model may be quoting text from the PR, and a
 * verdict planted in the PR must never be taken for the model's own.
 */
export function parseVerdict(text: string, rules: VerdictRules): ParseResult {
  const candidates = jsonObjects(text).filter((o) => o.value !== null && typeof o.value === 'object' && !Array.isArray(o.value) && 'decision' in o.value);
  if (candidates.length === 0) return { ok: false, error: 'no JSON verdict in the answer' };
  if (candidates.length > 1) return { ok: false, error: 'more than one verdict-like JSON object in the answer' };
  const found = candidates[0] as Found;
  if (!/^\s*(```\s*)?$/.test(text.slice(found.end))) return { ok: false, error: 'the verdict is not at the end of the answer' };
  if (/"decision"/.test(text.slice(0, found.start))) return { ok: false, error: 'the answer has another "decision" before the verdict' };
  const obj = found.value as Record<string, unknown>;

  const extra = Object.keys(obj).filter((k) => !(KEYS as readonly string[]).includes(k));
  if (extra.length > 0) return { ok: false, error: `unknown fields: ${extra.join(', ')}` };
  const missing = KEYS.filter((k) => !(k in obj));
  if (missing.length > 0) return { ok: false, error: `missing fields: ${missing.join(', ')}` };

  const { decision, risk, confidence, summary, reasons, risk_areas, files_reviewed, affected_code } = obj;
  if (decision !== 'safe' && decision !== 'needs_human') return { ok: false, error: 'decision must be "safe" or "needs_human"' };
  if (risk !== 'low' && risk !== 'medium' && risk !== 'high') return { ok: false, error: 'risk must be low, medium or high' };
  if (typeof confidence !== 'number' || !Number.isInteger(confidence) || confidence < 1 || confidence > 5) {
    return { ok: false, error: 'confidence must be a whole number from 1 to 5' };
  }
  if (typeof summary !== 'string' || summary.trim() === '' || summary.length > 300) {
    return { ok: false, error: 'summary must be a non-empty string of at most 300 characters' };
  }
  if (!isStringArray(reasons) || reasons.length < 1 || reasons.length > 6) return { ok: false, error: 'reasons must be 1 to 6 strings' };
  if (!isStringArray(risk_areas)) return { ok: false, error: 'risk_areas must be an array of strings' };
  if (!isStringArray(files_reviewed)) return { ok: false, error: 'files_reviewed must be an array of strings' };
  if (
    !Array.isArray(affected_code) ||
    affected_code.length > 10 ||
    !affected_code.every(
      (a) =>
        a !== null &&
        typeof a === 'object' &&
        Object.keys(a).every((k) => k === 'location' || k === 'why') &&
        typeof (a as Record<string, unknown>).location === 'string' &&
        typeof (a as Record<string, unknown>).why === 'string',
    )
  ) {
    return { ok: false, error: 'affected_code must be at most 10 objects with location and why' };
  }

  if (decision === 'safe' && risk === 'high') return { ok: false, error: 'contradiction: "safe" with high risk' };

  if (rules.role === 'slice') {
    const unlisted = rules.sliceFiles.filter((f) => !files_reviewed.includes(f));
    if (unlisted.length > 0) return { ok: false, error: `files_reviewed does not list: ${unlisted.join(', ')}` };
  }
  if (decision === 'safe' && rules.runtimeChanged && affected_code.length === 0) {
    return { ok: false, error: 'it said "safe" for a change to code or config but listed no code it checked (affected_code is empty), so there is no proof of the impact pass' };
  }

  return {
    ok: true,
    verdict: {
      decision,
      risk,
      confidence,
      summary: summary.trim(),
      reasons,
      risk_areas,
      files_reviewed,
      affected_code: affected_code as Verdict['affected_code'],
    },
  };
}
