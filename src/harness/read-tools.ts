// Read-only file tools for harnesses that bring no safe read tool of their own
// (Codex only has a shell). Everything stays inside one root folder, and every
// read reports the exact line range it returned: that range is the proof of
// reading (SPEC section 4.6), written by this code, never by the model.
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { matchesGlobPattern } from '../globs.ts';
import type { FileRead } from '../types.ts';

/** Most lines one read returns, like the read tools of the other harnesses. */
export const MAX_READ_LINES = 2000;
/** Longer lines are cut. A changed file with such a line already needs a human (section 4.6). */
export const MAX_LINE_CHARS = 2000;
/**
 * Most characters one tool result holds. Kept well under what the agent cuts
 * from a tool result before the model sees it, so what the log says was
 * returned is what the model got.
 */
export const MAX_RESULT_CHARS = 24_000;
const MAX_MATCHES = 200;
const MAX_GLOB_RESULTS = 500;
const MAX_GREP_FILE_BYTES = 1_000_000;

export class ToolError extends Error {}

export interface ToolResult {
  text: string;
  /** Set only by a successful read. */
  read?: FileRead;
}

/** Resolves a path the model gave to a real file inside root, or throws. Symlinks out of root are refused. */
export function insideRoot(root: string, p: string): { abs: string; rel: string } {
  const realRoot = realpathSync(root);
  let real: string;
  try {
    real = realpathSync(isAbsolute(p) ? p : resolve(realRoot, p));
  } catch {
    // The model may give a path under the root as it was spelled before realpath (macOS /tmp, for example).
    try {
      real = realpathSync(isAbsolute(p) ? join(realRoot, relative(root, p)) : resolve(root, p));
    } catch {
      throw new ToolError(`no such file: ${p}`);
    }
  }
  const rel = relative(realRoot, real);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new ToolError(`outside the repository: ${p}`);
  return { abs: real, rel: rel.split(sep).join('/') };
}

function looksBinary(abs: string): boolean {
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

function fileLines(abs: string): string[] {
  const text = readFileSync(abs, 'utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function cut(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} [line cut at ${MAX_LINE_CHARS} characters]` : line;
}

function positiveInt(v: unknown, name: string, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ToolError(`${name} must be a whole number of 1 or more`);
  return n;
}

/** Returns numbered lines ("12\tcode"), at most MAX_READ_LINES and MAX_RESULT_CHARS, and the range it returned. */
export function readTool(root: string, args: { path?: unknown; offset?: unknown; limit?: unknown }): ToolResult {
  if (typeof args.path !== 'string' || args.path === '') throw new ToolError('path is required');
  const { abs, rel } = insideRoot(root, args.path);
  const st = statSync(abs);
  if (st.isDirectory()) throw new ToolError(`${rel} is a folder; use glob to list it`);
  if (looksBinary(abs)) throw new ToolError(`${rel} is a binary file`);
  const lines = fileLines(abs);
  if (lines.length === 0) return { text: `${rel} is empty.`, read: { path: rel, fromLine: 1, toLine: 0 } };
  const from = positiveInt(args.offset, 'offset', 1);
  if (from > lines.length) throw new ToolError(`${rel} has ${lines.length} lines; offset ${from} is past the end`);
  const limit = Math.min(positiveInt(args.limit, 'limit', MAX_READ_LINES), MAX_READ_LINES);
  const out: string[] = [];
  let size = 0;
  let to = from - 1;
  for (let n = from; n <= Math.min(lines.length, from + limit - 1); n++) {
    const line = `${n}\t${cut(lines[n - 1] ?? '')}`;
    if (out.length > 0 && size + line.length + 1 > MAX_RESULT_CHARS) break;
    out.push(line);
    size += line.length + 1;
    to = n;
  }
  const more = to < lines.length ? `\n(${rel}: lines ${from}-${to} of ${lines.length}. Read again with offset ${to + 1} for the rest.)` : `\n(${rel}: lines ${from}-${to} of ${lines.length}.)`;
  return { text: out.join('\n') + more, read: { path: rel, fromLine: from, toLine: to } };
}

/** Every file under dir, as paths relative to root. Skips .git and symlinks. */
function walk(realRoot: string, dir: string, out: string[], max: number): void {
  if (out.length >= max) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= max) return;
    if (e.name === '.git') continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(realRoot, abs, out, max);
    else if (e.isFile()) out.push(relative(realRoot, abs).split(sep).join('/'));
  }
}

function files(root: string, under: unknown, max = 50_000): { realRoot: string; list: string[] } {
  const realRoot = realpathSync(root);
  const start = typeof under === 'string' && under !== '' ? insideRoot(root, under).abs : realRoot;
  const list: string[] = [];
  if (statSync(start).isDirectory()) walk(realRoot, start, list, max);
  else list.push(relative(realRoot, start).split(sep).join('/'));
  return { realRoot, list };
}

/** Lists files matching a glob such as "src/**\/*.ts". Never counts as reading. */
export function globTool(root: string, args: { pattern?: unknown; path?: unknown }): ToolResult {
  if (typeof args.pattern !== 'string' || args.pattern === '') throw new ToolError('pattern is required');
  const pattern = args.pattern.replace(/^\.\//, '');
  const { list } = files(root, args.path);
  const hits = list.filter((f) => matchesGlobPattern(f, pattern));
  if (hits.length === 0) return { text: `No files match ${args.pattern}.` };
  const shown = hits.slice(0, MAX_GLOB_RESULTS);
  return { text: shown.join('\n') + (hits.length > shown.length ? `\n(${hits.length - shown.length} more not shown; use a narrower pattern.)` : '') };
}

/** Searches file contents with a JavaScript regular expression. Shows matching lines; never counts as reading. */
export function grepTool(root: string, args: { pattern?: unknown; path?: unknown; glob?: unknown; ignore_case?: unknown }): ToolResult {
  if (typeof args.pattern !== 'string' || args.pattern === '') throw new ToolError('pattern is required');
  let re: RegExp;
  try {
    re = new RegExp(args.pattern, args.ignore_case === true ? 'i' : '');
  } catch (e) {
    throw new ToolError(`bad pattern: ${(e as Error).message}`);
  }
  const glob = typeof args.glob === 'string' && args.glob !== '' ? args.glob : undefined;
  const { realRoot, list } = files(root, args.path);
  const out: string[] = [];
  let size = 0;
  let total = 0;
  for (const f of list) {
    if (glob && !matchesGlobPattern(f, glob)) continue;
    const abs = join(realRoot, f);
    try {
      if (statSync(abs).size > MAX_GREP_FILE_BYTES || looksBinary(abs)) continue;
    } catch {
      continue;
    }
    const lines = fileLines(abs);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i] ?? '')) continue;
      total++;
      const hit = `${f}:${i + 1}: ${(lines[i] ?? '').slice(0, 300)}`;
      if (out.length < MAX_MATCHES && size + hit.length < MAX_RESULT_CHARS) {
        out.push(hit);
        size += hit.length + 1;
      }
    }
  }
  if (total === 0) return { text: `No matches for ${args.pattern}.` };
  return { text: out.join('\n') + (total > out.length ? `\n(${total - out.length} more matches not shown; narrow the search.)` : '') };
}

export const TOOL_DEFINITIONS = [
  {
    name: 'read',
    description: `Read a file in the repository. Returns numbered lines ("12<TAB>code"), at most ${MAX_READ_LINES} lines per call; read again with offset for the rest. Every read is logged: a changed file counts as reviewed only when its reads cover every line.`,
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the repository root' },
        offset: { type: 'integer', minimum: 1, description: 'First line to return (default 1)' },
        limit: { type: 'integer', minimum: 1, description: `Most lines to return (default and maximum ${MAX_READ_LINES})` },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'grep',
    description: 'Search file contents in the repository with a JavaScript regular expression. Returns "path:line: text" for each matching line.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression' },
        path: { type: 'string', description: 'File or folder to search (default: the whole repository)' },
        glob: { type: 'string', description: 'Only search files matching this glob, for example "*.ts"' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'glob',
    description: 'List repository files matching a glob, for example "src/**/*.ts" or "*.md".',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern' },
        path: { type: 'string', description: 'Folder to search in (default: the whole repository)' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
] as const;

/** Identifies a read call by what was asked, to match a read-log entry to the agent's own record of the call. */
export function callKey(args: Record<string, unknown>): string {
  return JSON.stringify([args.path ?? null, args.offset ?? null, args.limit ?? null]);
}

export function callTool(root: string, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'read':
      return readTool(root, args);
    case 'grep':
      return grepTool(root, args);
    case 'glob':
      return globTool(root, args);
    default:
      throw new ToolError(`unknown tool: ${name}`);
  }
}
