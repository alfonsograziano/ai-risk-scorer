import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../src/harness/process.ts';

test('the timeout holds even when a child process keeps stdout open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nhr-proc-'));
  const bin = join(dir, 'agent');
  // The background sleep inherits stdout and outlives the killed shell.
  await writeFile(bin, '#!/bin/sh\nsleep 30 &\nsleep 30\n');
  await chmod(bin, 0o755);
  const started = Date.now();
  const r = await runProcess('agent', bin, [], { cwd: dir, env: { PATH: process.env.PATH ?? '' }, timeoutMs: 1_000, graceMs: 200 });
  assert.equal(r.timedOut, true);
  // Without the grace stop this waits the full 30 seconds of the orphaned sleep.
  assert.ok(Date.now() - started < 10_000, 'did not wait for the orphaned child');
});
