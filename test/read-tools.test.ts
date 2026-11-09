import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callKey, globTool, grepTool, MAX_READ_LINES, MAX_RESULT_CHARS, readTool, ToolError } from '../src/harness/read-tools.ts';

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nhr-tools-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'src/a.ts'), 'const a = 1;\r\nexport { a };\n');
  await writeFile(join(root, 'src/empty.ts'), '');
  await writeFile(join(root, 'big.ts'), Array.from({ length: 3000 }, (_, i) => `const line${i + 1} = ${i + 1}; // some padding to make lines longer`).join('\n'));
  await writeFile(join(root, 'long.ts'), `${'x'.repeat(5000)}\nshort\n`);
  await writeFile(join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
  await writeFile(join(root, '.git/config'), 'token = secret');
  return root;
}

test('read returns numbered lines and the exact range it returned', async () => {
  const root = await repo();
  const r = readTool(root, { path: 'src/a.ts' });
  assert.deepEqual(r.read, { path: 'src/a.ts', fromLine: 1, toLine: 2 });
  assert.match(r.text, /^1\tconst a = 1;\n2\texport \{ a \};\n/, 'CRLF is stripped');
  assert.deepEqual(readTool(root, { path: './src/a.ts', offset: 2 }).read, { path: 'src/a.ts', fromLine: 2, toLine: 2 });
  assert.deepEqual(readTool(root, { path: join(root, 'src/a.ts') }).read, { path: 'src/a.ts', fromLine: 1, toLine: 2 }, 'an absolute path inside the root works');
  assert.deepEqual(readTool(root, { path: 'src/empty.ts' }).read, { path: 'src/empty.ts', fromLine: 1, toLine: 0 });
});

test('read stops at the line and size limits and says where to go on', async () => {
  const root = await repo();
  const r = readTool(root, { path: 'big.ts' });
  assert.ok(r.text.length <= MAX_RESULT_CHARS + 200);
  const to = r.read?.toLine ?? 0;
  assert.ok(to > 100 && to < MAX_READ_LINES, `stopped by size at line ${to}`);
  assert.equal(r.text.split('\n').filter((l) => /^\d+\t/.test(l)).length, to, 'the range is exactly the lines in the text');
  assert.match(r.text, new RegExp(`offset ${to + 1}`));
  assert.deepEqual(readTool(root, { path: 'big.ts', offset: 2990, limit: 50 }).read, { path: 'big.ts', fromLine: 2990, toLine: 3000 });
  assert.match(readTool(root, { path: 'long.ts' }).text, /line cut at 2000 characters/);
});

test('read refuses anything outside the root, folders, binaries and bad arguments', async () => {
  const root = await repo();
  const outside = await mkdtemp(join(tmpdir(), 'nhr-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
  await symlink(outside, join(root, 'linkdir'));
  const refuses = (args: Record<string, unknown>, re: RegExp) => assert.throws(() => readTool(root, args), (e: unknown) => e instanceof ToolError && re.test(e.message));
  refuses({ path: '../x' }, /outside the repository|no such file/);
  refuses({ path: join(outside, 'secret.txt') }, /outside the repository/);
  refuses({ path: '/etc/hosts' }, /outside the repository/);
  refuses({ path: 'link.txt' }, /outside the repository/);
  refuses({ path: 'linkdir/secret.txt' }, /outside the repository/);
  refuses({ path: 'src' }, /is a folder/);
  refuses({ path: 'bin.dat' }, /binary/);
  refuses({ path: 'nope.ts' }, /no such file/);
  refuses({}, /path is required/);
  refuses({ path: 'src/a.ts', offset: 0 }, /offset must be/);
  refuses({ path: 'src/a.ts', offset: 9 }, /past the end/);
});

test('grep and glob search the root, skip .git and symlinks, and never count as reads', async () => {
  const root = await repo();
  await symlink('/etc', join(root, 'etc-link'));
  const g = grepTool(root, { pattern: 'export' });
  assert.equal(g.read, undefined);
  assert.match(g.text, /^src\/a\.ts:2: export \{ a \};/);
  assert.match(grepTool(root, { pattern: 'token' }).text, /No matches/, '.git is skipped');
  assert.match(grepTool(root, { pattern: 'EXPORT', ignore_case: true, glob: '*.ts' }).text, /src\/a\.ts:2/);
  assert.throws(() => grepTool(root, { pattern: '(' }), /bad pattern/);
  assert.equal(globTool(root, { pattern: '*.ts' }).text, 'big.ts\nlong.ts\nsrc/a.ts\nsrc/empty.ts');
  assert.equal(globTool(root, { pattern: 'src/**' }).text, 'src/a.ts\nsrc/empty.ts');
  assert.match(globTool(root, { pattern: 'hosts' }).text, /No files match/, 'symlinked folders are not followed');
});

test('the MCP server answers over stdio and logs each read before replying', async () => {
  const root = await repo();
  const log = join(await mkdtemp(join(tmpdir(), 'nhr-log-')), 'reads.jsonl');
  const child = spawn(process.execPath, [new URL('../src/harness/read-tools-server.ts', import.meta.url).pathname], {
    env: { PATH: process.env.PATH ?? '', NHR_ROOT: root, NHR_READ_LOG: log },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const replies: Record<string, unknown>[] = [];
  let buf = '';
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
      replies.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const send = (m: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  send({ id: 3, method: 'tools/call', params: { name: 'read', arguments: { path: 'src/a.ts' } } });
  send({ id: 4, method: 'tools/call', params: { name: 'read', arguments: { path: '../etc' } } });
  send({ id: 5, method: 'nope' });
  while (replies.length < 5) await new Promise((r) => setTimeout(r, 20));
  child.kill();
  const byId = (id: number) => replies.find((r) => r.id === id) as { result?: Record<string, unknown>; error?: { code: number } };
  assert.equal((byId(1).result as { protocolVersion: string }).protocolVersion, '2025-06-18');
  assert.deepEqual((byId(2).result as { tools: { name: string }[] }).tools.map((t) => t.name), ['read', 'grep', 'glob']);
  assert.match(JSON.stringify(byId(3).result), /1\\tconst a = 1;/);
  assert.equal((byId(4).result as { isError: boolean }).isError, true);
  assert.equal(byId(5).error?.code, -32601);
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)), [
    { path: 'src/a.ts', fromLine: 1, toLine: 2, call: callKey({ path: 'src/a.ts' }) },
  ]);
});
