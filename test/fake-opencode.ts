// Stand-in for the `opencode` binary in the end-to-end tests (see e2e.ts). It
// behaves like a reviewer that does every read the slice plan requires and then
// answers, in the JSON event format `opencode run --format json` prints.
// The answer is the content of FAKE_ANSWER_FILE, or a "safe" verdict when that
// is unset. The harness strips the job env from the agent, so e2e.ts sets the
// variable in a wrapper script, not in the env of main.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const message = process.argv[process.argv.length - 1] ?? '';
const workdir = process.cwd();
const dir = readdirSync(workdir).find((d) => d.startsWith('.needs-human-review-'));
const m = /slices\/(\d+)\.json/.exec(message);
const emit = (e: unknown) => process.stdout.write(`${JSON.stringify(e)}\n`);

let files: string[] = [];
if (dir && m) {
  const plan = JSON.parse(readFileSync(join(workdir, dir, 'slices', `${m[1]}.json`), 'utf8')) as {
    items: { path: string; mustRead: { path: string; fromLine?: number; toLine?: number; totalLines: number }[] }[];
  };
  files = [...new Set(plan.items.map((i) => i.path))];
  for (const r of plan.items.flatMap((i) => i.mustRead)) {
    const from = r.fromLine ?? 1;
    const to = r.toLine ?? r.totalLines;
    emit({ type: 'tool_use', part: { messageID: 'm1', tool: 'read', state: { status: 'completed', input: { path: r.path }, output: `Read file ${r.path}, lines ${from}-${to}\n` } } });
  }
}
const answerFile = process.env.FAKE_ANSWER_FILE;
const text = answerFile
  ? readFileSync(answerFile, 'utf8')
  : JSON.stringify({
      decision: 'safe',
      risk: 'low',
      confidence: 5,
      summary: 'Small change.',
      reasons: ['Looks contained.'],
      risk_areas: [],
      files_reviewed: files,
      affected_code: [{ location: 'src/index.ts:1', why: 'Entry point.' }],
    });
emit({ type: 'text', part: { messageID: 'm2', type: 'text', text } });
emit({ type: 'step_finish', part: { cost: 0, tokens: { input: 1, output: 1 } } });
