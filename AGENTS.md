# AGENTS.md

Needs Human Review is a GitHub Action that answers one question for every PR: does it need a human review, or can it merge on its own? `SPEC.md` is the source of truth for behavior. Read it before changing anything.

## Rules

- Pure TypeScript, run directly by Node 26 with type stripping. No build step, no JavaScript files.
- Only erasable syntax: no `enum`, no `namespace`, no constructor parameter properties. `tsconfig.json` enforces it.
- Imports use the `.ts` extension.
- Zero runtime dependencies. Use Node built-ins and `fetch`. Dev dependencies are `typescript` and `@types/node` only.
- Fail safe: any error, timeout or unclear answer must end in "needs a human". Never in a merge.
- Keep the logic pure where you can (gates, slices, verdict, aggregate, decide) and test it without GitHub or a model.

## Commands

```bash
npm run check    # typecheck + tests, must pass before every commit
npm test         # tests only
npm run local -- --help   # run the full review locally against a git repo
```

## Layout

- `src/` the action. `src/main.ts` is the entry point for GitHub Actions.
- `src/harness/` adapters for coding agents: `opencode.ts`, `claude-code.ts` and `codex.ts` are the real ones, `fake.ts` is for tests. `read-tools.ts` and `read-tools-server.ts` are read-only tools served over MCP, for agents with no safe read tool of their own (Codex). `settings.ts` lists each harness's settings and defaults, `create.ts` builds the adapter. A new harness needs an entry in both, an install step in `action.yml`, and a credentials allow-list.
- `prompts/` the default system prompt and the fixed output contract.
- `test/` `node:test` tests, one file per module.
- `scripts/` local tools: the local runner, the sandbox builder and the README diagram renderer.
- `docs/` the README diagram: `diagram/how-it-works.html` is the source, the PNGs are rendered from it.
