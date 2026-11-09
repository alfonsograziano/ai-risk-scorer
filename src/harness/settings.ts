// Which harnesses exist and which settings each one takes. Pure: no I/O, so
// the config reader can check settings without loading an adapter.

export const HARNESS_NAMES = ['opencode', 'claude-code', 'codex', 'fake'] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

export type HarnessSettings = Record<string, string>;

interface SettingSpec {
  /** Used when the setting is not given. Empty means "not set". */
  default: string;
  /** Returns a problem, or undefined when the value is fine. */
  check?: (value: string) => string | undefined;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const version = (v: string) => (VERSION.test(v) ? undefined : `must be a release number like 1.2.3, got "${v}"`);
// A model is passed to the CLI as the value of --model, so it must not start with a dash.
const providerModel = (v: string) => (/^(?!-)[^/\s]+\/\S+$/.test(v) ? undefined : `must look like provider/model, got "${v}"`);
const oneWord = (v: string) => (/^(?!-)\S+$/.test(v) ? undefined : `must be one word that does not start with a dash, got "${v}"`);
const baseUrl = (v: string) => {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return `must be a URL, got "${v}"`;
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return `must use https (http only for localhost), got "${v}"`;
  // The URL goes into the verdict record, so nothing that could be a secret: no user info, query or fragment.
  if (u.username || u.password || u.search || u.hash) return 'must not hold credentials, a query or a fragment; pass the key in the api-key input';
  return undefined;
};
const auth = (v: string) => (['x-api-key', 'bearer'].includes(v) ? undefined : `must be x-api-key or bearer, got "${v}"`);
const oneOf = (allowed: string[]) => (v: string) => (allowed.includes(v) ? undefined : `must be ${allowed.slice(0, -1).join(', ')} or ${allowed.at(-1)}, got "${v}"`);
const effort = oneOf(['low', 'medium', 'high', 'xhigh', 'max']);
const codexEffort = oneOf(['minimal', 'low', 'medium', 'high', 'xhigh']);

/** Every harness takes a `model`. The rest is per harness. */
export const HARNESS_SETTINGS: Record<HarnessName, Record<string, SettingSpec>> = {
  opencode: {
    model: { default: 'opencode/deepseek-v4.1-flash', check: providerModel },
    version: { default: '2.2.5', check: version },
  },
  'claude-code': {
    model: { default: 'claude-sonnet-5-5', check: oneWord },
    version: { default: '2.1.319', check: version },
    effort: { default: '', check: effort },
    // The Anthropic-compatible endpoint, for a gateway or proxy. Empty is Anthropic's own API.
    'base-url': { default: '', check: baseUrl },
    // How api-key is sent. Empty means x-api-key for Anthropic's API, bearer when base-url is set.
    auth: { default: '', check: auth },
  },
  codex: {
    // Codex's own default model in the pinned release.
    model: { default: 'gpt-6.1-sol', check: oneWord },
    version: { default: '0.167.0', check: version },
    // model_reasoning_effort. Empty uses the model's default.
    effort: { default: '', check: codexEffort },
    // An OpenAI Responses API endpoint, for a gateway or proxy. Empty is OpenAI's own API.
    'base-url': { default: '', check: baseUrl },
  },
  fake: {
    model: { default: 'fake/none', check: oneWord },
  },
};

/**
 * Parses the `harness-settings` input: one `key: value` per line. Blank lines
 * and lines starting with # are skipped. The value is everything after the
 * first colon, so values may hold colons (a Bedrock ARN, for example).
 */
export function parseSettings(text: string): { settings: HarnessSettings; problems: string[] } {
  const settings: HarnessSettings = {};
  const problems: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    const key = colon === -1 ? '' : line.slice(0, colon).trim();
    if (key === '') {
      problems.push(`harness-settings lines must look like "key: value", got "${line}"`);
      continue;
    }
    if (Object.hasOwn(settings, key)) problems.push(`harness-settings sets "${key}" twice`);
    settings[key] = line.slice(colon + 1).trim();
  }
  return { settings, problems };
}

/** Fills in the defaults and checks every value against the chosen harness. */
export function resolveSettings(harness: HarnessName, given: HarnessSettings): { settings: HarnessSettings; problems: string[] } {
  const specs = HARNESS_SETTINGS[harness];
  const problems: string[] = [];
  const settings: HarnessSettings = {};
  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(specs, key)) problems.push(`harness-settings: "${key}" is not a setting of the ${harness} harness (it takes ${Object.keys(specs).join(', ')})`);
  }
  for (const [key, spec] of Object.entries(specs)) {
    // An empty value ("model:") is the same as leaving the key out, never an empty model.
    const value = (Object.hasOwn(given, key) ? given[key] : '') || spec.default;
    if (value === '') continue;
    const problem = spec.check?.(value);
    if (problem) problems.push(`harness-settings: ${key} ${problem}`);
    settings[key] = value;
  }
  return { settings, problems };
}
