// Runs the real entry point (src/main.ts) as GitHub Actions would: a
// workflow_run event, a mock GitHub REST API on localhost and a fake opencode
// binary in place of the reviewer. Used by main.test.ts.
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FAKE_OPENCODE = fileURLToPath(new URL('./fake-opencode.ts', import.meta.url));

export interface Comment {
  id: number;
  user: { login: string; type: string };
  body: string;
}

export interface GhState {
  pr: {
    number: number;
    state: string;
    draft: boolean;
    title: string;
    body: string;
    user: { login: string; type: string };
    labels: { name: string }[];
    base: { ref: string; sha: string; repo: { full_name: string } };
    head: { ref: string; sha: string; repo: { full_name: string } };
  };
  /** Conclusion of the one CI check run, per head SHA. Missing means success. */
  ci: Record<string, string>;
  comments: Comment[];
  /** Every request, as "METHOD /path". */
  requests: string[];
  statuses: { sha: string; state: string; context: string }[];
  merges: { sha: string; base: string; labels: string[] }[];
  /** Called after GET /pulls/1 is answered: lets a test change the PR, like a user would. */
  afterGetPull?: (s: GhState) => void;
}

export function newState(base: string, head: string): GhState {
  return {
    pr: {
      number: 1,
      state: 'open',
      draft: false,
      title: 'Small fix',
      body: 'Small fix.',
      user: { login: 'dev', type: 'User' },
      labels: [],
      base: { ref: 'main', sha: base, repo: { full_name: 'o/r' } },
      head: { ref: 'feature', sha: head, repo: { full_name: 'o/r' } },
    },
    ci: {},
    comments: [],
    requests: [],
    statuses: [],
    merges: [],
  };
}

/** What the fake reviewer does: answer with this text (default: a "safe" verdict), or crash. */
export type Reviewer = { answer?: string } | { crash: true };

export interface MainRun {
  /** stdout and stderr of main.ts. */
  out: string;
  code: number | null;
  /** The step outputs main.ts wrote to GITHUB_OUTPUT. */
  outputs: Record<string, string>;
  /** How many times the reviewer agent was started. */
  reviewerCalls: number;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

function mockGitHub(s: GhState) {
  let nextId = 1000;
  return createServer(async (req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    s.requests.push(`${req.method} ${p}`);
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    const data = req.method === 'GET' || req.method === 'DELETE' ? {} : await body(req);
    let m: RegExpExecArray | null;
    if (req.method === 'GET' && /\/actions\/runs\//.test(p)) return send(200, { check_suite_id: 999 });
    if (req.method === 'GET' && p === '/repos/o/r/pulls/1') {
      send(200, s.pr);
      s.afterGetPull?.(s);
      return;
    }
    if (req.method === 'GET' && (m = /\/commits\/(\w+)\/check-runs$/.exec(p))) {
      const conclusion = s.ci[m[1] ?? ''] ?? 'success';
      return send(200, { check_runs: [{ name: 'test', status: 'completed', conclusion, check_suite: { id: 1 } }] });
    }
    if (req.method === 'GET' && /\/commits\/\w+\/status$/.test(p)) return send(200, { statuses: [] });
    if (req.method === 'GET' && p === '/repos/o/r/issues/1/comments') return send(200, s.comments);
    if (req.method === 'POST' && p === '/repos/o/r/issues/1/comments') {
      s.comments.push({ id: nextId++, user: { login: 'github-actions[bot]', type: 'Bot' }, body: String(data.body) });
      return send(201, {});
    }
    if (req.method === 'PATCH' && (m = /\/issues\/comments\/(\d+)$/.exec(p))) {
      const c = s.comments.find((x) => x.id === Number(m?.[1]));
      if (c) c.body = String(data.body);
      return send(200, {});
    }
    if (req.method === 'POST' && p === '/repos/o/r/issues/1/labels') {
      for (const l of data.labels as string[]) if (!s.pr.labels.some((x) => x.name === l)) s.pr.labels.push({ name: l });
      return send(200, s.pr.labels);
    }
    if (req.method === 'DELETE' && (m = /\/issues\/1\/labels\/(.+)$/.exec(p))) {
      const name = decodeURIComponent(m[1] ?? '');
      const had = s.pr.labels.length;
      s.pr.labels = s.pr.labels.filter((l) => l.name !== name);
      return send(had === s.pr.labels.length ? 404 : 200, { message: 'Label does not exist' });
    }
    if (req.method === 'POST' && (m = /\/statuses\/(\w+)$/.exec(p))) {
      s.statuses.push({ sha: m[1] ?? '', state: String(data.state), context: String(data.context) });
      return send(201, {});
    }
    if (req.method === 'PUT' && p === '/repos/o/r/pulls/1/merge') {
      if (data.sha !== s.pr.head.sha) return send(409, { message: 'Head branch was modified' });
      s.merges.push({ sha: String(data.sha), base: s.pr.base.ref, labels: s.pr.labels.map((l) => l.name) });
      return send(200, { merged: true });
    }
    send(404, { message: `mock: no route for ${req.method} ${p}` });
  });
}

/** GITHUB_OUTPUT holds `name<<__ARS__\nvalue\n__ARS__\n` blocks. */
function parseOutputs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^(\S+)<<__ARS__\n([\s\S]*?)\n?__ARS__$/gm)) out[m[1] ?? ''] = m[2] ?? '';
  return out;
}

/** Runs src/main.ts once for the current PR head. `inputs` are action inputs, like `mode`. */
export async function runMain(repoDir: string, s: GhState, inputs: Record<string, string> = {}, reviewer: Reviewer = {}): Promise<MainRun> {
  const server = mockGitHub(s);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const tmp = await mkdtemp(join(tmpdir(), 'ars-e2e-'));
  try {
    const eventPath = join(tmp, 'event.json');
    await writeFile(
      eventPath,
      JSON.stringify({
        workflow_run: { event: 'pull_request', conclusion: 'success', head_sha: s.pr.head.sha, pull_requests: [{ number: 1, head: { sha: s.pr.head.sha } }] },
        repository: { default_branch: 'main', full_name: 'o/r' },
      }),
    );

    // The agent gets an allow-listed env, so the wrapper sets what the fake needs itself.
    const calls = join(tmp, 'calls');
    await writeFile(calls, '');
    let script = `#!/bin/sh\necho call >> '${calls}'\n`;
    if ('crash' in reviewer) {
      script += 'echo "fake reviewer crashed" >&2\nexit 3\n';
    } else {
      if (reviewer.answer !== undefined) {
        await writeFile(join(tmp, 'answer.txt'), reviewer.answer);
        script += `export FAKE_ANSWER_FILE='${join(tmp, 'answer.txt')}'\n`;
      }
      script += `exec '${process.execPath}' '${FAKE_OPENCODE}' "$@"\n`;
    }
    const bin = join(tmp, 'opencode');
    await writeFile(bin, script);
    await chmod(bin, 0o755);

    const outputFile = join(tmp, 'output');
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GITHUB_EVENT_NAME: 'workflow_run',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_API_URL: `http://127.0.0.1:${port}`,
      GITHUB_WORKSPACE: repoDir,
      GITHUB_RUN_ID: '42',
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: join(tmp, 'summary'),
      RUNNER_TEMP: tmp,
      OPENCODE_BIN: bin,
      // The fake stands in for opencode. The default harness (claude-code)
      // would start the real `claude` binary.
      INPUT_HARNESS: 'opencode',
      INPUT_GITHUB_TOKEN: 'mock-token',
      INPUT_CI_WAIT_MINUTES: '0',
      ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase().replace(/-/g, '_')}`, v])),
    };
    const { out, code } = await new Promise<{ out: string; code: number | null }>((resolve) => {
      const child = spawn(process.execPath, [join(ROOT, 'src/main.ts')], { cwd: repoDir, env });
      let text = '';
      child.stdout.on('data', (d) => (text += d));
      child.stderr.on('data', (d) => (text += d));
      child.on('close', (c) => resolve({ out: text, code: c }));
    });
    const outputs = parseOutputs(await readFile(outputFile, 'utf8').catch(() => ''));
    const reviewerCalls = (await readFile(calls, 'utf8')).split('\n').filter(Boolean).length;
    return { out, code, outputs, reviewerCalls };
  } finally {
    server.close();
    await rm(tmp, { recursive: true, force: true });
  }
}
