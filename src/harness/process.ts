// What every CLI adapter shares: the allow-listed environment, path clean-up
// and running the agent process under a hard timeout.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { HarnessError } from './types.ts';

/**
 * The environment the agent gets. Only what a CLI needs to run, plus what the
 * adapter adds to reach the model: never the action inputs (INPUT_GITHUB_TOKEN),
 * runner tokens or anything else from the job. What the agent can read, the
 * model can repeat.
 */
const ENV_ALLOW = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']);
const ENV_ALLOW_PATTERN = /^XDG_[A-Z_]+$/;
const ENV_NEVER = /^(INPUT_|GITHUB_|ACTIONS_|RUNNER_)/;

/** `credentials` matches the variables the harness needs to reach its model. */
export function agentEnv(source: Record<string, string | undefined>, credentials: RegExp): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined || ENV_NEVER.test(k)) continue;
    if (ENV_ALLOW.has(k) || ENV_ALLOW_PATTERN.test(k) || credentials.test(k)) env[k] = v;
  }
  return env;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** A path from the tool-call log, relative to the workdir like the changed-file list. */
export function relativePath(workdir: string, p: string): string {
  if (!isAbsolute(p)) return p.replace(/^\.\//, '');
  for (const root of new Set([workdir, safeRealpath(workdir)])) {
    const rel = relative(root, p);
    if (!rel.startsWith('..') && !isAbsolute(rel)) return rel;
  }
  return p;
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs the agent with no stdin. Kills it at the timeout. Rejects only if it cannot start. */
export function runProcess(name: string, bin: string, args: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number; graceMs?: number }): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let grace: NodeJS.Timeout | undefined;
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const finish = (code: number | null) => {
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      // 'close' waits for stdout and stderr to close. A process the agent started
      // can keep them open after the agent is dead, so do not wait for it forever.
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null);
      }, opts.graceMs ?? 5_000);
    }, opts.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      clearTimeout(grace);
      reject(new HarnessError(`could not start ${name}: ${err.message}`));
    });
    child.on('close', finish);
  });
}

export function timeoutMessage(timeoutMs: number): string {
  return `timed out after ${Math.round(timeoutMs / 60_000)} minutes`;
}
