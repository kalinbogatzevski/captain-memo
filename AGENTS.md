# AGENTS.md

Orientation for AI coding agents working on this repository. Humans want [CONTRIBUTING.md](CONTRIBUTING.md).

## What this project is

Captain Memo is a **local-first memory layer for AI coding agents**. It keeps one searchable
corpus on your machine — SQLite + `sqlite-vec` + FTS5 — and every MCP-speaking coding tool on
that machine shares it. What one tool learns, the others recall.

Two moving parts: a background **worker** (indexes, embeds, summarizes) and an **MCP server**
plus **hooks** that the AI tool loads. Nothing calls a cloud database; retrieval is local.

## Runtime

**Bun ≥ 1.1.14**, TypeScript. Not Node — `bun` runs the TypeScript source directly, so there is
**no build step** for the worker, CLI, or hooks. The only bundling target is the distributable
plugin (`bun run build:plugin`).

## Commands

```bash
bun install
bun test                       # full suite
bun test tests/unit/           # or: bun run test:unit
bun test tests/integration/    # or: bun run test:integration
bun test tests/hooks/          # or: bun run test:hooks
bun run typecheck              # tsc --noEmit
bun src/cli/index.ts doctor    # health-check a local install
```

Run `bun run typecheck` **and** `bun test` before proposing a change. Both must be clean.

Handy during development:

```bash
bun run worker:dev             # worker with --watch, against ./.captain-memo.dev
bun run mcp:start              # the MCP server on stdio
bun bin/captain-memo <cmd>     # the CLI
```

## Layout

| Path | What lives there |
|---|---|
| `src/worker/` | Background worker: indexing, embedding, summarizing, the tick loop |
| `src/mcp-server.ts` | MCP server the AI tools connect to |
| `src/hooks/` | `UserPromptSubmit` / `PreToolUse` / `Stop` hook handlers |
| `src/cli/` | `captain-memo` CLI, including install and connect |
| `src/services/` | Embedders, summarizer providers, search, storage |
| `src/shared/` | Types and helpers used across the above |
| `src/migration/` | Data-format upgrades between versions |
| `src/dreaming/`, `src/eval/` | Consolidation and retrieval evaluation |
| `tests/` | `unit/`, `integration/`, `hooks/` |

## Conventions that are easy to get wrong

- **Every commit needs a DCO sign-off.** `git commit -s`. A PR with an unsigned commit gets
  bounced. See [CONTRIBUTING.md](CONTRIBUTING.md#developer-certificate-of-origin-dco).
- **Commit messages:** loose conventional commits, `<type>(<scope>): <summary>`. The body
  explains *why*; the diff already shows *what*.
- **Don't add a build step or a bundler.** Running source directly is deliberate.
- **Don't add dependencies casually.** This installs on other people's machines, including
  offline ones. Prefer Bun's standard library.
- **Memory files are `.md`/`.mdc` only.** Discovery globs must end in those extensions so
  credentials and session logs are *structurally* unindexable. A test enforces this — if you
  are touching discovery, do not weaken it into a blocklist.
- **Never commit anything from a user's real corpus** into tests or fixtures.

## License

Apache-2.0. Contributions are released under the same license.
