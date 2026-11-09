// First step of action.yml. Checks the config before anything is installed,
// and tells the install steps which harness to install, and which release.
import { appendFile } from 'node:fs/promises';
import { ConfigError, readConfig } from './inputs.ts';

const env = process.env;

// GitHub masks secrets passed from `secrets.*`, but not a key pasted in as plain text.
// Mask it before reading the config, so no config error can print it either.
const apiKey = (env.INPUT_API_KEY ?? '').trim();
for (const line of apiKey.split(/\r?\n/)) if (line.trim() !== '') console.log(`::add-mask::${line.trim()}`);

try {
  const config = readConfig(env);
  const out = { harness: config.harness, version: config.harnessSettings.version ?? '' };
  console.log(`Harness: ${out.harness}${out.version ? ` ${out.version}` : ''}, model ${config.model}`);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(''));
} catch (e) {
  const message = e instanceof ConfigError ? e.message : String(e);
  console.error(message);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `### 🔴 Needs Human Review: bad config\n\n${message}\n`);
  process.exitCode = 1;
}
