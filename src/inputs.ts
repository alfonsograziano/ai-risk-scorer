import { validateGlob } from './globs.ts';
import { HARNESS_NAMES, harnessProblems, parseSettings, resolveSettings, type HarnessName, type HarnessSettings } from './harness/settings.ts';
import type { MergeMethod, Mode, Risk } from './types.ts';

export interface Config {
  mode: Mode;
  harness: HarnessName;
  /** Settings for the harness, with its defaults filled in. Always has `model`. */
  harnessSettings: HarnessSettings;
  /** Same as harnessSettings.model, kept here because the report and record show it. */
  model: string;
  /**
   * The model key from the api-key input. The harness passes it to the agent
   * under the variable it reads. A secret: never logged, never in the record.
   * Empty means the agent's own variables in the job env are used.
   */
  apiKey: string;
  githubToken: string;
  protectedPaths: string[];
  selfProtectedPaths: string[];
  maxLinesChanged: number;
  maxFilesChanged: number;
  generatedPaths: string[];
  generatedDefaults: boolean;
  systemPrompt: string;
  systemPromptFile: string;
  customInstructions: string;
  customInstructionsFile: string;
  maxRiskToMerge: Risk;
  minConfidence: number;
  sliceMaxTokens: number;
  maxSlices: number;
  maxParallel: number;
  sliceTimeoutMinutes: number;
  timeoutMinutes: number;
  requiredChecks: string[];
  /** How long to wait for checks that are still running, such as GitHub App checks. */
  ciWaitMinutes: number;
  baseBranches: string[];
  allowForks: boolean;
  skipLabel: string;
  mergeMethod: MergeMethod;
  comment: boolean;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Bad Needs Human Review config:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;

/** Reads an input the way GitHub passes it: INPUT_<NAME>, with - turned into _. */
function raw(env: Env, name: string): string {
  return (env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] ?? '').trim();
}

/** One item per line. Blank lines and lines starting with # are skipped. */
export function parseList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/**
 * Reads `harness-settings`, plus the top-level `model` input, the usual way to
 * pick the model for any harness. Setting the model both ways is an error, not
 * a silent pick.
 */
function readHarnessSettings(env: Env, harness: HarnessName, problems: string[]): HarnessSettings {
  const parsed = parseSettings(env.INPUT_HARNESS_SETTINGS ?? '');
  problems.push(...parsed.problems);
  const given = parsed.settings;
  const model = raw(env, 'model');
  if (model !== '') {
    if (Object.hasOwn(given, 'model')) problems.push('set model or "model" in harness-settings, not both');
    else given.model = model;
  }
  const resolved = resolveSettings(harness, given);
  problems.push(...resolved.problems);
  return resolved.settings;
}

/** The harness when the `harness` input is empty. */
export const DEFAULT_HARNESS: HarnessName = 'claude-code';

export function readConfig(env: Env): Config {
  const problems: string[] = [];

  const oneOf = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const v = raw(env, name) || fallback;
    if (!(allowed as readonly string[]).includes(v)) {
      problems.push(`${name} must be one of ${allowed.join(', ')}, got "${v}"`);
      return fallback;
    }
    return v as T;
  };

  const int = (name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    const v = raw(env, name);
    if (v === '') return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}, got "${v}"`);
      return fallback;
    }
    return n;
  };

  const bool = (name: string, fallback: boolean): boolean => {
    const v = raw(env, name).toLowerCase();
    if (v === '') return fallback;
    if (v === 'true') return true;
    if (v === 'false') return false;
    problems.push(`${name} must be true or false, got "${v}"`);
    return fallback;
  };

  const globs = (name: string): string[] => {
    const list = parseList(raw(env, name));
    for (const g of list) {
      try {
        validateGlob(g);
      } catch (e) {
        problems.push(`${name} has a bad glob "${g}": ${(e as Error).message}`);
      }
    }
    return list;
  };

  const harness = oneOf('harness', HARNESS_NAMES, DEFAULT_HARNESS);
  const harnessSettings = readHarnessSettings(env, harness, problems);

  const config: Config = {
    mode: oneOf('mode', ['shadow', 'advisory', 'autonomous'] as const, 'shadow'),
    harness,
    harnessSettings,
    model: harnessSettings.model ?? '',
    apiKey: raw(env, 'api-key'),
    githubToken: raw(env, 'github-token'),
    protectedPaths: globs('protected-paths'),
    selfProtectedPaths: globs('self-protected-paths'),
    maxLinesChanged: int('max-lines-changed', 0, 0),
    maxFilesChanged: int('max-files-changed', 0, 0),
    generatedPaths: globs('generated-paths'),
    generatedDefaults: bool('generated-defaults', true),
    systemPrompt: raw(env, 'system-prompt'),
    systemPromptFile: raw(env, 'system-prompt-file'),
    customInstructions: raw(env, 'custom-instructions'),
    customInstructionsFile: raw(env, 'custom-instructions-file'),
    maxRiskToMerge: oneOf('max-risk-to-merge', ['low', 'medium'] as const, 'low'),
    minConfidence: int('min-confidence', 4, 1, 5),
    sliceMaxTokens: int('slice-max-tokens', 40_000, 2_000),
    maxSlices: int('max-slices', 25, 0),
    maxParallel: int('max-parallel', 4, 1, 16),
    sliceTimeoutMinutes: int('slice-timeout-minutes', 10, 1, 120),
    timeoutMinutes: int('timeout-minutes', 30, 1, 360),
    requiredChecks: parseList(raw(env, 'required-checks')),
    ciWaitMinutes: int('ci-wait-minutes', 10, 0, 60),
    baseBranches: parseList(raw(env, 'base-branches')),
    allowForks: bool('allow-forks', false),
    skipLabel: raw(env, 'skip-label') || 'needs-human-review:always',
    mergeMethod: oneOf('merge-method', ['squash', 'merge', 'rebase'] as const, 'squash'),
    comment: bool('comment', true),
  };

  if (config.systemPrompt && config.systemPromptFile) {
    problems.push('set system-prompt or system-prompt-file, not both');
  }
  if (config.customInstructions && config.customInstructionsFile) {
    problems.push('set custom-instructions or custom-instructions-file, not both');
  }
  problems.push(...harnessProblems(config.harness, config.harnessSettings, config.apiKey !== ''));
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
