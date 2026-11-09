import { ClaudeCodeHarness } from './claude-code.ts';
import { FakeHarness } from './fake.ts';
import { OpenCodeHarness } from './opencode.ts';
import type { HarnessName, HarnessSettings } from './settings.ts';
import type { Harness } from './types.ts';

/**
 * The adapter for a harness name. `model` reaches the adapter on every run
 * (HarnessInput.model); the other settings are fixed for the whole review.
 * `version` is not used here: it only picks what action.yml installs.
 * `apiKey` is the api-key input; each adapter puts it where its agent reads it.
 */
export function createHarness(name: HarnessName, settings: HarnessSettings, apiKey = ''): Harness {
  const key = apiKey ? { apiKey } : {};
  switch (name) {
    case 'opencode':
      return new OpenCodeHarness(key);
    case 'claude-code':
      return new ClaudeCodeHarness({
        ...key,
        ...(settings.effort ? { effort: settings.effort } : {}),
        ...(settings['base-url'] ? { baseUrl: settings['base-url'] } : {}),
        ...(settings.auth ? { auth: settings.auth } : {}),
      });
    case 'fake':
      return new FakeHarness(() => ({ error: 'fake harness: no model' }));
  }
}
