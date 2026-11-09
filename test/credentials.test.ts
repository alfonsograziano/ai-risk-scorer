import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveCredentialFilesOut } from '../src/credentials.ts';

test('a credentials file in the workspace is moved out and the variables follow it', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'nhr-ws-'));
  const safe = await mkdtemp(join(tmpdir(), 'nhr-safe-'));
  const creds = join(workspace, 'gha-creds-abc.json');
  await writeFile(creds, '{"type":"external_account"}');
  const outside = join(safe, 'elsewhere.json');
  await writeFile(outside, '{}');
  const env: Record<string, string | undefined> = { GOOGLE_APPLICATION_CREDENTIALS: creds, GOOGLE_GHA_CREDS_PATH: creds, CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: outside };

  assert.deepEqual(await moveCredentialFilesOut(workspace, safe, env), ['gha-creds-abc.json']);
  assert.equal(existsSync(creds), false, 'the reviewer can no longer open it');
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, join(safe, 'nhr-gha-creds-abc.json'));
  assert.equal(env.GOOGLE_GHA_CREDS_PATH, env.GOOGLE_APPLICATION_CREDENTIALS, 'both variables point at the one moved file');
  assert.equal(await readFile(env.GOOGLE_APPLICATION_CREDENTIALS ?? '', 'utf8'), '{"type":"external_account"}');
  assert.equal(env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE, outside, 'a file outside the workspace stays where it is');
  assert.deepEqual(await moveCredentialFilesOut(workspace, safe, { GOOGLE_APPLICATION_CREDENTIALS: join(workspace, 'missing.json') }), []);
});
