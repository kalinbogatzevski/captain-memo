# Captain Remember Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Captain Memo a first-class curated-memory WRITE path — one internal `writeMemory()` primitive fed by a worker route, an MCP `remember` tool, a `captain-memo remember` CLI command, and an opt-in autonomous promotion job that distils durable observations into curated memory.

**Architecture:** A single `writeMemory(input, deps)` primitive in `src/worker/memory-writer.ts` owns frontmatter fill (LLM-enriched with deterministic fallback), update-in-place dedup, atomic write, and in-process re-indexing; three thin callers (`POST /remember` worker route, MCP `remember` tool, `captain-memo remember` CLI) and one opt-in promotion timer feed it. Target-dir resolution follows a 3-way precedence (override → project slug from cwd → rememberDir), and an observations `promoted_at` column gives promotion idempotency.

**Tech Stack:** Bun + TypeScript (`.ts` extensions in imports), `zod` for parsing, `bun:sqlite` migrations, `bun test`; all code lives in worker/cli/mcp/shared CORE — no federation imports, ci(moat) stays green.

---

### Task 1

**Add the remember/promote env constants + DEFAULT_* values to `src/shared/paths.ts`**

`writeMemory`, the route, the CLI, doctor, and the promotion job all read these. The file already imports `homedir` and `join` (lines 1–2) and has an `ENV_*` block and a `DEFAULT_*` block; we extend both. Per spec §8 the defaults are `DEFAULT_REMEMBER_DIR=join(homedir(),'.claude','memory')`, `DEFAULT_PROMOTE_INTERVAL_MS=21_600_000`, `DEFAULT_PROMOTE_MAX_PER_RUN=5`, `DEFAULT_REMEMBER_DEDUP_THRESHOLD=0.85`; promote-enable is OFF unless the env value is exactly `'1'` (no DEFAULT const — readers compare the env string to `'1'`).

- [ ] **Files block.**
  - Modify: `/home/kalin/projects/captain-memo/src/shared/paths.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/unit/shared/paths.test.ts` (new file)

- [ ] **Write the failing test.** Create `/home/kalin/projects/captain-memo/tests/unit/shared/paths.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import {
  ENV_REMEMBER_DIR, DEFAULT_REMEMBER_DIR,
  ENV_PROMOTE_ENABLE,
  ENV_PROMOTE_INTERVAL_MS, DEFAULT_PROMOTE_INTERVAL_MS,
  ENV_PROMOTE_MAX_PER_RUN, DEFAULT_PROMOTE_MAX_PER_RUN,
  ENV_REMEMBER_DEDUP_THRESHOLD, DEFAULT_REMEMBER_DEDUP_THRESHOLD,
} from '../../../src/shared/paths.ts';

test('env-var names match the CAPTAIN_MEMO_* contract verbatim', () => {
  expect(ENV_REMEMBER_DIR).toBe('CAPTAIN_MEMO_REMEMBER_DIR');
  expect(ENV_PROMOTE_ENABLE).toBe('CAPTAIN_MEMO_PROMOTE_ENABLE');
  expect(ENV_PROMOTE_INTERVAL_MS).toBe('CAPTAIN_MEMO_PROMOTE_INTERVAL_MS');
  expect(ENV_PROMOTE_MAX_PER_RUN).toBe('CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN');
  expect(ENV_REMEMBER_DEDUP_THRESHOLD).toBe('CAPTAIN_MEMO_REMEMBER_DEDUP_THRESHOLD');
});

test('defaults match spec §8', () => {
  expect(DEFAULT_REMEMBER_DIR).toBe(join(homedir(), '.claude', 'memory'));
  expect(DEFAULT_PROMOTE_INTERVAL_MS).toBe(21_600_000);
  expect(DEFAULT_PROMOTE_MAX_PER_RUN).toBe(5);
  expect(DEFAULT_REMEMBER_DEDUP_THRESHOLD).toBe(0.85);
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/unit/shared/paths.test.ts` — fails resolving the named imports, e.g. `error: Export named 'ENV_REMEMBER_DIR' not found in module '.../src/shared/paths.ts'` (0 pass).

- [ ] **Minimal implementation.** In `/home/kalin/projects/captain-memo/src/shared/paths.ts`, immediately after the `ENV_OBSERVATION_TICK_MS` line insert:

```ts

// Captain Remember — curated-memory write path + autonomous promotion (design §8).
// Promotion target / CLI default when no project cwd is present.
export const ENV_REMEMBER_DIR = 'CAPTAIN_MEMO_REMEMBER_DIR';
// Master switch for autonomous promotion. OFF by default — only the string '1' enables.
export const ENV_PROMOTE_ENABLE = 'CAPTAIN_MEMO_PROMOTE_ENABLE';
// Promotion tick cadence (ms) and per-run cap.
export const ENV_PROMOTE_INTERVAL_MS = 'CAPTAIN_MEMO_PROMOTE_INTERVAL_MS';
export const ENV_PROMOTE_MAX_PER_RUN = 'CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN';
// Semantic update-in-place similarity cutoff for writeMemory() dedup.
export const ENV_REMEMBER_DEDUP_THRESHOLD = 'CAPTAIN_MEMO_REMEMBER_DEDUP_THRESHOLD';
```

Then after the existing `DEFAULT_OBSERVATION_TICK_MS` line append:

```ts

// Captain Remember defaults (design §8). Tunable via the ENV_* names above.
// Promotion has no live session cwd, so it writes to this user-global dir by default.
export const DEFAULT_REMEMBER_DIR = join(homedir(), '.claude', 'memory');
export const DEFAULT_PROMOTE_INTERVAL_MS = 21_600_000; // 6h
export const DEFAULT_PROMOTE_MAX_PER_RUN = 5;
export const DEFAULT_REMEMBER_DEDUP_THRESHOLD = 0.85;
```

(No new import needed — `homedir` and `join` are already imported.)

- [ ] **Run it, expect PASS.** `bun test tests/unit/shared/paths.test.ts` → `2 pass, 0 fail`.

- [ ] **Commit.**

```
git add src/shared/paths.ts tests/unit/shared/paths.test.ts
git commit -m "feat(shared): add remember/promote env constants + defaults"
```

---

### Task 2

**Implement `projectSlugFromCwd(cwd)` in `src/shared/paths.ts` with Claude-Code-encoding unit cases**

`writeMemory` resolves its project-scoped target dir through `projectSlugFromCwd(cwd)`. The encoding must match the dirs Claude Code already creates under `~/.claude/projects/`.

RECONCILED CONTRACT DECISION (the two drafts disagreed; this is the binding choice): the encoder is a **plain per-character replace** — every character matching `[/._]` becomes `-`, with case, digits, and existing dashes preserved verbatim; **no trim, no dedupe of consecutive dashes**. This matches the real observed dir `/home/kalin/projects/erp-platform/--claude-worktrees-status-workflow-graph-editor` → `-home-kalin-projects-erp-platform--claude-worktrees-status-workflow-graph-editor` (a literal `--claude…` subdir keeps its double dash, proving per-char not run-collapse). The collapsing/trailing-strip variant from the other draft is REJECTED because it cannot reproduce that real dir. Implementation: `cwd.replace(/[/._]/g, '-')`.

- [ ] **Files block.**
  - Modify: `/home/kalin/projects/captain-memo/src/shared/paths.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/unit/shared/paths.test.ts` (extend Task 1's file)

- [ ] **Write the failing test.** Append to `/home/kalin/projects/captain-memo/tests/unit/shared/paths.test.ts`:

```ts
import { projectSlugFromCwd } from '../../../src/shared/paths.ts';

test('projectSlugFromCwd — real observed dirs: slash→dash, case + digits preserved', () => {
  expect(projectSlugFromCwd('/home/kalin/projects/captain-memo'))
    .toBe('-home-kalin-projects-captain-memo');
  expect(projectSlugFromCwd('/home/kalin/projects/123net-aelita'))
    .toBe('-home-kalin-projects-123net-aelita');
  expect(projectSlugFromCwd('/home/kalin/projects/ERP-UNIFIED-DOCS'))
    .toBe('-home-kalin-projects-ERP-UNIFIED-DOCS');
});

test('projectSlugFromCwd — consecutive literal dashes survive (no dedupe)', () => {
  expect(projectSlugFromCwd('/home/kalin/projects/erp-platform/--claude-worktrees-status-workflow-graph-editor'))
    .toBe('-home-kalin-projects-erp-platform--claude-worktrees-status-workflow-graph-editor');
});

test('projectSlugFromCwd — dots encoded to dash (Claude Code scheme)', () => {
  expect(projectSlugFromCwd('/home/kalin/.config/captain-memo'))
    .toBe('-home-kalin--config-captain-memo');
  expect(projectSlugFromCwd('/home/kalin/projects/my.app.v2'))
    .toBe('-home-kalin-projects-my-app-v2');
});

test('projectSlugFromCwd — underscores encoded to dash (Claude Code scheme)', () => {
  expect(projectSlugFromCwd('/home/kalin/projects/_archive/123net_erp'))
    .toBe('-home-kalin-projects--archive-123net-erp');
});

test('projectSlugFromCwd — trailing slash yields trailing dash', () => {
  expect(projectSlugFromCwd('/home/kalin/projects/captain-memo/'))
    .toBe('-home-kalin-projects-captain-memo-');
});

test('projectSlugFromCwd — leading slash root only', () => {
  expect(projectSlugFromCwd('/')).toBe('-');
  expect(projectSlugFromCwd('/tmp')).toBe('-tmp');
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/unit/shared/paths.test.ts` — `error: Export named 'projectSlugFromCwd' not found in module '.../src/shared/paths.ts'`. The 2 constant tests from Task 1 still pass; the 6 new tests error on the missing import.

- [ ] **Minimal implementation.** Append to `/home/kalin/projects/captain-memo/src/shared/paths.ts` (after the `DEFAULT_REMEMBER_DEDUP_THRESHOLD` line from Task 1):

```ts

/**
 * Encode an absolute cwd into Claude Code's project-dir slug, matching the
 * directories under ~/.claude/projects/. Every '/', '.', and '_' becomes '-';
 * case, digits, and existing dashes are preserved verbatim (no trim, no
 * dedupe of consecutive dashes). Observed real dirs confirm the '/' rule and
 * dash-preservation, e.g.:
 *   /home/kalin/projects/captain-memo -> -home-kalin-projects-captain-memo
 *   /home/kalin/projects/erp-platform/--claude-worktrees-x
 *                                   -> -home-kalin-projects-erp-platform--claude-worktrees-x
 * The '.'/'_' rule follows Claude Code's own encoder (no local dir exercises
 * those chars to observe directly — see spec §12 item 1).
 */
export function projectSlugFromCwd(cwd: string): string {
  return cwd.replace(/[/._]/g, '-');
}
```

- [ ] **Run it, expect PASS.** `bun test tests/unit/shared/paths.test.ts` → `8 pass, 0 fail` (2 from Task 1 + 6 here).

- [ ] **Commit.**

```
git add src/shared/paths.ts tests/unit/shared/paths.test.ts
git commit -m "feat(shared): projectSlugFromCwd encodes cwd to Claude Code dir slug"
```

---

### Task 3

**`writeMemory` module scaffold — types, frontmatter render, deterministic fallback**

Create `src/worker/memory-writer.ts` with the contract types and the pure helpers `prefixForType`, `slugify`, `renderFrontmatter`, `deterministicFrontmatter`. The rendered frontmatter MUST round-trip through the real chunker `chunkMemoryFile` (`src/worker/chunkers/memory-file.ts`): a leading `---\n…\n---\n` block, one `key: value` per line, `name`/`description`/`type` keys, body below. The fallback (spec §5) runs when `generate` throws or is unavailable.

- [ ] **Files block.**
  - Create: `/home/kalin/projects/captain-memo/src/worker/memory-writer.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/unit/memory-writer.test.ts` (new; extended by later tasks)

- [ ] **Write the failing test.** Create `/home/kalin/projects/captain-memo/tests/unit/memory-writer.test.ts`:

```ts
import { test, expect } from 'bun:test';
import {
  renderFrontmatter, deterministicFrontmatter, slugify, prefixForType,
} from '../../src/worker/memory-writer.ts';
import { chunkMemoryFile } from '../../src/worker/chunkers/memory-file.ts';

test('renderFrontmatter — round-trips through chunkMemoryFile', () => {
  const doc = renderFrontmatter(
    { name: 'Use bun test', description: 'always run bun test', type: 'decision' },
    'Body line one.\n\n## A section\ndetails',
  );
  const chunks = chunkMemoryFile(doc, '/x/decision_use-bun-test.md');
  const meta = chunks[0]!.metadata as Record<string, unknown>;
  expect(meta.name).toBe('Use bun test');
  expect(meta.description).toBe('always run bun test');
  expect(meta.memory_type).toBe('decision');
  expect(chunks.some(c => (c.metadata as Record<string, unknown>).section_title === 'A section')).toBe(true);
});

test('deterministicFrontmatter — name=first non-empty line, type=given, slug=slugified', () => {
  const fm = deterministicFrontmatter(
    '\n\n  Prefer pnpm over npm here  \nmore detail follows on the next lines',
    'preference',
  );
  expect(fm.name).toBe('Prefer pnpm over npm here');
  expect(fm.type).toBe('preference');
  expect(fm.slug).toBe('prefer-pnpm-over-npm-here');
  expect(fm.description.length).toBeGreaterThan(0);
});

test('deterministicFrontmatter — truncates an overlong first line for name', () => {
  const long = 'x'.repeat(300);
  const fm = deterministicFrontmatter(long, 'reference');
  expect(fm.name.length).toBeLessThanOrEqual(120);
});

test('slugify — lowercases, dashes non-alnum, trims edges, no doubles', () => {
  expect(slugify('  Use Bun, Not Node!! ')).toBe('use-bun-not-node');
  expect(slugify('123net_aelita')).toBe('123net-aelita');
});

test('prefixForType — maps known types, falls back to the type itself', () => {
  expect(prefixForType('preference')).toBe('feedback');
  expect(prefixForType('feedback')).toBe('feedback');
  expect(prefixForType('decision')).toBe('decision');
  expect(prefixForType('reference')).toBe('reference');
  expect(prefixForType('wild')).toBe('wild');
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/unit/memory-writer.test.ts` — module-not-found / `export 'renderFrontmatter' not found` for `src/worker/memory-writer.ts`.

- [ ] **Minimal implementation.** Create `/home/kalin/projects/captain-memo/src/worker/memory-writer.ts`:

```ts
import type { IngestPipeline } from './ingest.ts';
import type { SummarizerTransport } from './summarizer.ts';

export interface RememberInput {
  body: string;
  type: string;
  name?: string;
  description?: string;
  slug?: string;
  projectContext: { cwd?: string };
  sourceObservationId?: number;
  targetDirOverride?: string;
}

export interface MemoryHit {
  source_path: string;
  score: number;
  chunk_id: string;
}

export interface WriteMemoryDeps {
  ingest: IngestPipeline;
  embed: (texts: string[]) => Promise<number[][]>;
  searchMemory: (queryEmbedding: number[], dir: string, k: number) => Promise<MemoryHit[]>;
  generate: SummarizerTransport;
  registerSelfWrite: (absPath: string) => void;
  rememberDir: string;
  dedupThreshold: number;
}

export type WriteMemoryResult =
  | { ok: true; path: string; action: 'created' | 'updated'; doc_id: string }
  | { ok: false; reason: string };

export interface Frontmatter {
  name: string;
  description: string;
  slug: string;
  type: string;
}

const NAME_MAX = 120;
const DESC_MAX = 280;

// type -> filename prefix. Matches the existing feedback_/reference_ convention;
// introduces decision_. Unknown types use the type itself as prefix.
const PREFIX_MAP: Record<string, string> = {
  feedback: 'feedback',
  preference: 'feedback',
  reference: 'reference',
  decision: 'decision',
};

export function prefixForType(type: string): string {
  return PREFIX_MAP[type] ?? type;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Render the `---` frontmatter block + body the memory chunker parses. */
export function renderFrontmatter(
  fm: Pick<Frontmatter, 'name' | 'description' | 'type'>,
  body: string,
  extra?: { originSessionId?: string; sourceObservationId?: number },
): string {
  const lines = ['---', `name: ${fm.name}`, `description: ${fm.description}`, `type: ${fm.type}`];
  if (extra?.originSessionId) lines.push(`originSessionId: ${extra.originSessionId}`);
  if (extra?.sourceObservationId !== undefined) lines.push(`sourceObservationId: ${extra.sourceObservationId}`);
  lines.push('---');
  return `${lines.join('\n')}\n${body.replace(/^\n+/, '')}`;
}

/** Spec §5 fallback: never block a write on the LLM. */
export function deterministicFrontmatter(body: string, type: string): Frontmatter {
  const firstLine = (body.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? type).slice(0, NAME_MAX);
  const name = firstLine.length > 0 ? firstLine : type;
  const description = body.trim().replace(/\s+/g, ' ').slice(0, DESC_MAX);
  return { name, description, slug: slugify(name) || slugify(type), type };
}
```

- [ ] **Run it, expect PASS.** `bun test tests/unit/memory-writer.test.ts` → all 5 tests pass.

- [ ] **Commit.**

```
git add src/worker/memory-writer.ts tests/unit/memory-writer.test.ts
git commit -m "feat(remember): memory-writer types + frontmatter render + deterministic fallback"
```

---

### Task 4

**`writeMemory` — target-dir resolution + LLM frontmatter fill via `deps.generate`**

Add `resolveTargetDir` (3-way precedence from the contract: `input.targetDirOverride` → `~/.claude/projects/<projectSlugFromCwd(cwd)>/memory` when cwd present → `deps.rememberDir`) and the `generate`-driven frontmatter fill, then the `writeMemory` entry point that wires them: resolve dir, `mkdir -p`, fill frontmatter (LLM enrich, fallback on throw). This task stops short of dedup/write — it returns a placeholder result. The `generate` transport is called with the summarizer shape (`{ model, system, user, max_tokens }` → `{ content: [{type:'text', text}], model }`); its JSON text is parsed against a zod schema. `model: ''` is passed because the transport resolves its own model chain internally.

- [ ] **Files block.**
  - Modify: `/home/kalin/projects/captain-memo/src/worker/memory-writer.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/unit/memory-writer.test.ts` (append)

- [ ] **Write the failing test.** Append to `/home/kalin/projects/captain-memo/tests/unit/memory-writer.test.ts`:

```ts
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { mock } from 'bun:test';
import { resolveTargetDir, fillFrontmatter } from '../../src/worker/memory-writer.ts';

const noopIngest = { indexFile: mock(async () => {}) } as any;

test('resolveTargetDir — targetDirOverride wins', () => {
  expect(resolveTargetDir(
    { body: 'b', type: 'decision', projectContext: { cwd: '/some/where' }, targetDirOverride: '/override/dir' },
    '/default/remember',
  )).toBe('/override/dir');
});

test('resolveTargetDir — cwd -> ~/.claude/projects/<slug>/memory', () => {
  expect(resolveTargetDir(
    { body: 'b', type: 'decision', projectContext: { cwd: '/home/kalin/projects/captain-memo' } },
    '/default/remember',
  )).toBe(join(homedir(), '.claude', 'projects', '-home-kalin-projects-captain-memo', 'memory'));
});

test('resolveTargetDir — no cwd -> rememberDir default', () => {
  expect(resolveTargetDir(
    { body: 'b', type: 'decision', projectContext: {} },
    '/default/remember',
  )).toBe('/default/remember');
});

test('fillFrontmatter — uses caller overrides verbatim, no generate call', async () => {
  const generate = mock(async () => { throw new Error('should not be called'); });
  const fm = await fillFrontmatter(
    { body: 'b', type: 'decision', name: 'N', description: 'D', slug: 's', projectContext: {} },
    generate as any,
  );
  expect(fm).toEqual({ name: 'N', description: 'D', slug: 's', type: 'decision' });
  expect(generate).not.toHaveBeenCalled();
});

test('fillFrontmatter — calls generate when a field is missing', async () => {
  const generate = mock(async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify({
      name: 'Gen Name', description: 'gen desc', slug: 'gen-name', type: 'decision',
    }) }],
    model: 'claude-haiku-4-5',
  }));
  const fm = await fillFrontmatter(
    { body: 'pick bun', type: 'decision', projectContext: {} },
    generate as any,
  );
  expect(generate).toHaveBeenCalledTimes(1);
  expect(fm.name).toBe('Gen Name');
  expect(fm.slug).toBe('gen-name');
});

test('fillFrontmatter — generate throws -> deterministic fallback', async () => {
  const generate = mock(async () => { throw new Error('transport offline'); });
  const fm = await fillFrontmatter(
    { body: 'Prefer pnpm here\nmore', type: 'preference', projectContext: {} },
    generate as any,
  );
  expect(generate).toHaveBeenCalledTimes(1);
  expect(fm.name).toBe('Prefer pnpm here');
  expect(fm.slug).toBe('prefer-pnpm-here');
  expect(fm.type).toBe('preference');
});

test('writeMemory — mkdirs the resolved target dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-mw-'));
  const target = join(dir, 'nested', 'memory');
  const generate = mock(async () => { throw new Error('offline'); });
  const res = await (await import('../../src/worker/memory-writer.ts')).writeMemory(
    { body: 'a note worth keeping', type: 'reference', projectContext: {}, targetDirOverride: target },
    {
      ingest: noopIngest,
      embed: mock(async () => { throw new Error('embedder offline'); }) as any,
      searchMemory: mock(async () => []) as any,
      generate: generate as any,
      registerSelfWrite: mock(() => {}),
      rememberDir: dir,
      dedupThreshold: 0.85,
    },
  );
  expect(res.ok).toBe(true);
  expect(existsSync(target)).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/unit/memory-writer.test.ts` — `export 'resolveTargetDir' not found` (and `fillFrontmatter`, `writeMemory`).

- [ ] **Minimal implementation.** In `/home/kalin/projects/captain-memo/src/worker/memory-writer.ts`, add to the imports at the top:

```ts
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { projectSlugFromCwd } from '../shared/paths.ts';
```

Then add below the existing helpers:

```ts
const FrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  slug: z.string().min(1),
  type: z.string().min(1),
});

const FILL_SYSTEM =
  `You distill a curated memory entry's metadata. Given the entry TYPE and BODY,
return ONLY a JSON object: {"name","description","slug","type"}. name = short title;
description = one line; slug = lowercase-dashed filename stem (no prefix, no extension);
type = echo the given type.`;

export function resolveTargetDir(input: RememberInput, rememberDir: string): string {
  if (input.targetDirOverride) return input.targetDirOverride;
  const cwd = input.projectContext.cwd;
  if (cwd) return join(homedir(), '.claude', 'projects', projectSlugFromCwd(cwd), 'memory');
  return rememberDir;
}

/** Fill missing frontmatter via the LLM transport; never throw — fall back deterministically. */
export async function fillFrontmatter(input: RememberInput, generate: SummarizerTransport): Promise<Frontmatter> {
  const complete = input.name && input.description && input.slug;
  if (complete) {
    return { name: input.name!, description: input.description!, slug: input.slug!, type: input.type };
  }
  try {
    const res = await generate({
      model: '', // transport resolves its own model chain
      system: FILL_SYSTEM,
      user: `TYPE: ${input.type}\nBODY:\n${input.body}`,
      max_tokens: 400,
    });
    const text = res.content.find(c => c.type === 'text')?.text ?? '';
    const match = /\{[\s\S]*\}/.exec(text);
    const json = JSON.parse(match ? match[0] : text);
    const parsed = FrontmatterSchema.parse({ type: input.type, ...json, type: json.type ?? input.type });
    return {
      name: input.name ?? parsed.name,
      description: input.description ?? parsed.description,
      slug: input.slug ?? parsed.slug,
      type: input.type,
    };
  } catch {
    const fb = deterministicFrontmatter(input.body, input.type);
    return {
      name: input.name ?? fb.name,
      description: input.description ?? fb.description,
      slug: input.slug ?? fb.slug,
      type: input.type,
    };
  }
}

export async function writeMemory(input: RememberInput, deps: WriteMemoryDeps): Promise<WriteMemoryResult> {
  if (!input.body || !input.body.trim()) return { ok: false, reason: 'body is required' };
  if (!input.type || !input.type.trim()) return { ok: false, reason: 'type is required' };

  const targetDir = resolveTargetDir(input, deps.rememberDir);
  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `mkdir failed: ${(err as Error).message}` };
  }

  const fm = await fillFrontmatter(input, deps.generate);

  // dedup + write wired in the next task; placeholder result keeps this task green.
  return { ok: true, path: join(targetDir, `${prefixForType(fm.type)}_${fm.slug}.md`), action: 'created', doc_id: `memory:${prefixForType(fm.type)}_${fm.slug}` };
}
```

- [ ] **Run it, expect PASS.** `bun test tests/unit/memory-writer.test.ts` → all tests (prior + 7 new) pass.

- [ ] **Commit.**

```
git add src/worker/memory-writer.ts tests/unit/memory-writer.test.ts
git commit -m "feat(remember): target-dir resolution + generate-driven frontmatter fill"
```

---

### Task 5

**`writeMemory` — dedup (filename collision + semantic) and create-vs-update target selection**

Add `findUpdateTarget`: (a) filename/slug collision — `<prefix>_<slug>.md` already in the target dir → update that file; else (b) semantic — `embed([body])`, `searchMemory(emb, dir, k)`, and if top hit's `score >= dedupThreshold` AND its `source_path` is inside the target dir → update that file; else create. Embedder failure skips (b), logs a warning, and never throws (spec §5). The `source_path.startsWith(dir)` guard is defense-in-depth so an unscoped `searchMemory` impl stays correct.

- [ ] **Files block.**
  - Modify: `/home/kalin/projects/captain-memo/src/worker/memory-writer.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/unit/memory-writer.test.ts` (append)

- [ ] **Write the failing test.** Append to `/home/kalin/projects/captain-memo/tests/unit/memory-writer.test.ts`:

```ts
import { writeFileSync, mkdirSync } from 'fs';
import { findUpdateTarget } from '../../src/worker/memory-writer.ts';

test('findUpdateTarget — filename collision -> that file, embedder never queried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-dd-'));
  const existing = join(dir, 'decision_use-bun.md');
  writeFileSync(existing, '---\nname: x\ntype: decision\n---\nold');
  const embed = mock(async () => { throw new Error('must not embed'); });
  const searchMemory = mock(async () => []);
  const target = await findUpdateTarget(
    'use bun', dir, 'decision_use-bun.md',
    { embed: embed as any, searchMemory: searchMemory as any, dedupThreshold: 0.85 },
  );
  expect(target).toBe(existing);
  expect(embed).not.toHaveBeenCalled();
  rmSync(dir, { recursive: true, force: true });
});

test('findUpdateTarget — semantic hit >= threshold in dir -> that file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-dd-'));
  const hitPath = join(dir, 'reference_existing.md');
  writeFileSync(hitPath, '---\nname: y\ntype: reference\n---\nbody');
  const embed = mock(async () => [[0.1, 0.2]]);
  const searchMemory = mock(async () => [{ source_path: hitPath, score: 0.91, chunk_id: 'memory:reference_existing:aa' }]);
  const target = await findUpdateTarget(
    'similar body', dir, 'reference_new.md',
    { embed: embed as any, searchMemory: searchMemory as any, dedupThreshold: 0.85 },
  );
  expect(embed).toHaveBeenCalledTimes(1);
  expect(target).toBe(hitPath);
  rmSync(dir, { recursive: true, force: true });
});

test('findUpdateTarget — semantic hit below threshold -> null (create)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-dd-'));
  const embed = mock(async () => [[0.1]]);
  const searchMemory = mock(async () => [{ source_path: join(dir, 'reference_x.md'), score: 0.4, chunk_id: 'c' }]);
  const target = await findUpdateTarget(
    'unique', dir, 'reference_new.md',
    { embed: embed as any, searchMemory: searchMemory as any, dedupThreshold: 0.85 },
  );
  expect(target).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test('findUpdateTarget — semantic hit OUTSIDE target dir is ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-dd-'));
  const embed = mock(async () => [[0.1]]);
  const searchMemory = mock(async () => [{ source_path: '/elsewhere/reference_x.md', score: 0.99, chunk_id: 'c' }]);
  const target = await findUpdateTarget(
    'x', dir, 'reference_new.md',
    { embed: embed as any, searchMemory: searchMemory as any, dedupThreshold: 0.85 },
  );
  expect(target).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test('findUpdateTarget — embedder failure skips semantic dedup, returns null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-dd-'));
  const embed = mock(async () => { throw new Error('embedder offline'); });
  const searchMemory = mock(async () => []);
  const target = await findUpdateTarget(
    'x', dir, 'reference_new.md',
    { embed: embed as any, searchMemory: searchMemory as any, dedupThreshold: 0.85 },
  );
  expect(target).toBeNull();
  expect(searchMemory).not.toHaveBeenCalled();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/unit/memory-writer.test.ts` — `export 'findUpdateTarget' not found`.

- [ ] **Minimal implementation.** In `/home/kalin/projects/captain-memo/src/worker/memory-writer.ts`, extend the `fs` import to include `existsSync`:

```ts
import { mkdirSync, existsSync } from 'fs';
```

Add `basename` to the `path` import:

```ts
import { join, basename } from 'path';
```

Add the helper:

```ts
const SEMANTIC_K = 3;

type DedupDeps = Pick<WriteMemoryDeps, 'embed' | 'searchMemory' | 'dedupThreshold'>;

/**
 * Decide the update target, or null to create. (a) filename collision first
 * (cheap, no embedder), then (b) semantic similarity scoped to `dir`. Embedder
 * failure degrades gracefully to "no semantic match" (spec §5).
 */
export async function findUpdateTarget(
  body: string,
  dir: string,
  filename: string,
  deps: DedupDeps,
): Promise<string | null> {
  const collision = join(dir, filename);
  if (existsSync(collision)) return collision;

  let embedding: number[];
  try {
    const [vec] = await deps.embed([body]);
    if (!vec) return null;
    embedding = vec;
  } catch (err) {
    console.warn(`[remember] embedder unavailable, skipping semantic dedup: ${(err as Error).message}`);
    return null;
  }

  const hits = await deps.searchMemory(embedding, dir, SEMANTIC_K);
  const top = hits[0];
  if (top && top.score >= deps.dedupThreshold && top.source_path.startsWith(dir)) {
    return top.source_path;
  }
  return null;
}
```

Wire it into `writeMemory` — replace the placeholder return (`// dedup + write wired in the next task; …` line and the `return { ok: true, … }` after it) with:

```ts
  const prefix = prefixForType(fm.type);
  const filename = `${prefix}_${fm.slug}.md`;
  const updateTarget = await findUpdateTarget(input.body, targetDir, filename, deps);
  const path = updateTarget ?? join(targetDir, filename);
  const action: 'created' | 'updated' = updateTarget ? 'updated' : 'created';

  return { ok: true, path, action, doc_id: `memory:${basename(path, '.md')}` };
```

- [ ] **Run it, expect PASS.** `bun test tests/unit/memory-writer.test.ts` → prior + 5 new tests pass.

- [ ] **Commit.**

```
git add src/worker/memory-writer.ts tests/unit/memory-writer.test.ts
git commit -m "feat(remember): filename + semantic dedup, create-vs-update target selection"
```

---

### Task 6

**`writeMemory` — atomic write, merge-on-update, registerSelfWrite + ingest.indexFile**

Complete the pipeline: render the document (create = frontmatter+body; update = read existing, one `generate` merge pass folding new info in, then overwrite), write atomically (temp file in the same dir then `rename`), `deps.registerSelfWrite(absPath)`, `await deps.ingest.indexFile(absPath, 'memory')`, and return the structured result. Disk/permission errors return `{ ok:false, reason }`. The returned `doc_id` is derived deterministically as `memory:<filename-stem>` (matching `parseDocId`'s `channel:source` shape) — callers need a stable document handle, not a chunk id.

- [ ] **Files block.**
  - Modify: `/home/kalin/projects/captain-memo/src/worker/memory-writer.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/unit/memory-writer.test.ts` (append)

- [ ] **Write the failing test.** Append to `/home/kalin/projects/captain-memo/tests/unit/memory-writer.test.ts`:

```ts
import { readFileSync, readdirSync } from 'fs';

function fullDeps(over: Partial<any> = {}) {
  return {
    ingest: { indexFile: mock(async () => {}) },
    embed: mock(async () => { throw new Error('no embed'); }),
    searchMemory: mock(async () => []),
    generate: mock(async () => { throw new Error('offline'); }),
    registerSelfWrite: mock(() => {}),
    rememberDir: '/unused',
    dedupThreshold: 0.85,
    ...over,
  };
}

test('writeMemory — create writes file, registers self-write, indexes once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-w-'));
  const deps = fullDeps();
  const res = await (await import('../../src/worker/memory-writer.ts')).writeMemory(
    { body: 'Prefer ripgrep over grep', type: 'preference', projectContext: {}, targetDirOverride: dir },
    deps as any,
  );
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.reason);
  expect(res.action).toBe('created');
  expect(res.path).toBe(join(dir, 'feedback_prefer-ripgrep-over-grep.md'));
  const written = readFileSync(res.path, 'utf-8');
  expect(written.startsWith('---\n')).toBe(true);
  expect(written).toContain('type: preference');
  expect(written).toContain('Prefer ripgrep over grep');
  expect(readdirSync(dir).every(f => f.endsWith('.md'))).toBe(true);
  expect(deps.registerSelfWrite).toHaveBeenCalledTimes(1);
  expect(deps.registerSelfWrite.mock.calls[0][0]).toBe(res.path);
  expect(deps.ingest.indexFile).toHaveBeenCalledTimes(1);
  expect(deps.ingest.indexFile.mock.calls[0]).toEqual([res.path, 'memory']);
  rmSync(dir, { recursive: true, force: true });
});

test('writeMemory — update merges via generate, overwrites same file (one file on disk)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-w-'));
  const existing = join(dir, 'feedback_prefer-ripgrep-over-grep.md');
  writeFileSync(existing, '---\nname: Prefer ripgrep over grep\ndescription: old\ntype: preference\n---\nOriginal note.');
  const generate = mock(async () => ({
    content: [{ type: 'text' as const, text: 'Original note.\n\nAlso: ripgrep respects .gitignore.' }],
    model: 'claude-haiku-4-5',
  }));
  const deps = fullDeps({ generate });
  const res = await (await import('../../src/worker/memory-writer.ts')).writeMemory(
    {
      body: 'ripgrep respects .gitignore', type: 'preference',
      name: 'Prefer ripgrep over grep', description: 'use rg', slug: 'prefer-ripgrep-over-grep',
      projectContext: {}, targetDirOverride: dir,
    },
    deps as any,
  );
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.reason);
  expect(res.action).toBe('updated');
  expect(res.path).toBe(existing);
  expect(generate).toHaveBeenCalledTimes(1);
  const merged = readFileSync(existing, 'utf-8');
  expect(merged).toContain('respects .gitignore');
  expect(readdirSync(dir).filter(f => f.endsWith('.md'))).toHaveLength(1);
  rmSync(dir, { recursive: true, force: true });
});

test('writeMemory — merge generate failure falls back to appended body, still writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-w-'));
  const existing = join(dir, 'reference_x.md');
  writeFileSync(existing, '---\nname: X\ndescription: d\ntype: reference\n---\nOld body.');
  const generate = mock(async () => { throw new Error('merge offline'); });
  const deps = fullDeps({ generate });
  const res = await (await import('../../src/worker/memory-writer.ts')).writeMemory(
    { body: 'new fact', type: 'reference', name: 'X', description: 'd', slug: 'x', projectContext: {}, targetDirOverride: dir },
    deps as any,
  );
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.reason);
  expect(res.action).toBe('updated');
  const merged = readFileSync(existing, 'utf-8');
  expect(merged).toContain('Old body.');
  expect(merged).toContain('new fact');
  rmSync(dir, { recursive: true, force: true });
});

test('writeMemory — ingest.indexFile failure surfaces as { ok:false }', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-w-'));
  const deps = fullDeps({ ingest: { indexFile: mock(async () => { throw new Error('vector down'); }) } });
  const res = await (await import('../../src/worker/memory-writer.ts')).writeMemory(
    { body: 'note', type: 'reference', projectContext: {}, targetDirOverride: dir },
    deps as any,
  );
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error('expected failure');
  expect(res.reason).toContain('vector down');
  rmSync(dir, { recursive: true, force: true });
});

test('writeMemory — missing body returns { ok:false, reason }', async () => {
  const res = await (await import('../../src/worker/memory-writer.ts')).writeMemory(
    { body: '   ', type: 'reference', projectContext: {} },
    fullDeps() as any,
  );
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error('expected failure');
  expect(res.reason).toBe('body is required');
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/unit/memory-writer.test.ts` — the create test fails (no file written; `registerSelfWrite`/`indexFile` never called) and the update/merge tests fail.

- [ ] **Minimal implementation.** In `/home/kalin/projects/captain-memo/src/worker/memory-writer.ts`, extend the `fs` import with the write/read/rename calls:

```ts
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
```

Add the merge helper:

```ts
const MERGE_SYSTEM =
  `You update a curated memory entry. Given the EXISTING entry body and NEW
information, return the merged body that PRESERVES the existing content and folds
in the new information without duplication. Return ONLY the merged body text, no
frontmatter, no commentary.`;

/** Fold new info into an existing body via the LLM; on failure, append the new body. */
async function mergeBody(existingBody: string, newBody: string, generate: SummarizerTransport): Promise<string> {
  try {
    const res = await generate({
      model: '',
      system: MERGE_SYSTEM,
      user: `EXISTING:\n${existingBody}\n\nNEW:\n${newBody}`,
      max_tokens: 1200,
    });
    const text = res.content.find(c => c.type === 'text')?.text?.trim();
    if (text) return text;
  } catch (err) {
    console.warn(`[remember] merge generate failed, appending: ${(err as Error).message}`);
  }
  return `${existingBody.trim()}\n\n${newBody.trim()}`;
}
```

Replace the decision-only tail of `writeMemory` (everything after the `const action: 'created' | 'updated' = …` line, i.e. the placeholder `return { ok: true, path, action, doc_id: … }` from Task 5) with:

```ts
  let body = input.body;
  if (updateTarget) {
    const existingRaw = readFileSync(updateTarget, 'utf-8').replace(/\r\n/g, '\n');
    const fmEnd = existingRaw.indexOf('\n---\n');
    const existingBody = existingRaw.startsWith('---\n') && fmEnd !== -1
      ? existingRaw.slice(fmEnd + 5)
      : existingRaw;
    body = await mergeBody(existingBody, input.body, deps.generate);
  }

  const doc = renderFrontmatter(
    { name: fm.name, description: fm.description, type: fm.type },
    body,
    input.sourceObservationId !== undefined ? { sourceObservationId: input.sourceObservationId } : undefined,
  );

  // Atomic write: temp file in the SAME dir, then rename — the watcher never
  // sees a half-written file.
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, doc, 'utf-8');
    renameSync(tmpPath, path);
  } catch (err) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    return { ok: false, reason: `write failed: ${(err as Error).message}` };
  }

  deps.registerSelfWrite(path);
  try {
    await deps.ingest.indexFile(path, 'memory');
  } catch (err) {
    return { ok: false, reason: `index failed: ${(err as Error).message}` };
  }

  return { ok: true, path, action, doc_id: `memory:${basename(path, '.md')}` };
```

- [ ] **Run it, expect PASS.** `bun test tests/unit/memory-writer.test.ts` → every test passes (frontmatter, fallback, resolve, fill, dedup, create, update/merge, merge-fallback, index-failure, missing-body).

- [ ] **Commit.**

```
git add src/worker/memory-writer.ts tests/unit/memory-writer.test.ts
git commit -m "feat(remember): atomic write + merge-on-update + registerSelfWrite/indexFile"
```

---

### Task 7

**Thread the raw `SummarizerTransport` and a self-write suppression set into `startWorker`**

The `/remember` route needs two things not currently reachable inside `startWorker`: (1) `WriteMemoryDeps.generate` is the **raw `SummarizerTransport`** (`(args) => Promise<...>`), but inside `startWorker` only `opts.summarize` (the observation-shaped wrapper) exists — the raw transport is constructed inside each `new Summarizer({...})` in `buildWorkerOptionsFromEnv` but never surfaced; (2) `WriteMemoryDeps.registerSelfWrite(absPath)` must suppress chokidar re-processing our own write. No suppression set exists today (the watcher only avoids double-index by attaching after the initial pass), so this task CREATES `selfWrites: Set<string>` + `registerSelfWrite` and makes the watcher `onEvent` consume it.

- [ ] **Files block.**
  - Modify: `/home/kalin/projects/captain-memo/src/worker/summarizer.ts`
  - Modify: `/home/kalin/projects/captain-memo/src/worker/index.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/unit/summarizer-transport.test.ts` (new)

- [ ] **Write the failing test.** Create `/home/kalin/projects/captain-memo/tests/unit/summarizer-transport.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { Summarizer, type SummarizerTransport } from '../../src/worker/summarizer.ts';

test('Summarizer exposes its underlying transport for reuse by writeMemory', () => {
  const calls: string[] = [];
  const transport: SummarizerTransport = async (args) => {
    calls.push(args.model);
    return { content: [{ type: 'text', text: '{}' }], model: args.model };
  };
  const s = new Summarizer({ apiKey: '', transport });
  const got = s.getTransport();
  expect(typeof got).toBe('function');
  void got({ model: 'm', system: 's', user: 'u', max_tokens: 10 });
  expect(calls).toEqual(['m']);
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/unit/summarizer-transport.test.ts` — TypeError / failure on `s.getTransport is not a function`.

- [ ] **Add the getter** to `src/worker/summarizer.ts`. After the existing `getActiveModel()` method, insert:

```ts
  /**
   * Exposed so the worker can reuse the model-fallback transport directly
   * (writeMemory drives frontmatter/merge fills via the raw transport, not
   * via the observation-shaped summarize()).
   */
  getTransport(): SummarizerTransport {
    return this.transport;
  }
```

- [ ] **Run it, expect PASS.** `bun test tests/unit/summarizer-transport.test.ts` → `1 pass`.

- [ ] **Add `summarizerTransport` to `WorkerOptions`.** In `src/worker/index.ts`, immediately after the `summarize?: ...` line in interface `WorkerOptions`, add:

```ts
  /** Raw model-fallback transport (from Summarizer.getTransport()). Surfaced so the
   *  /remember writer can drive frontmatter/merge fills directly — distinct from the
   *  observation-shaped `summarize` above. Absent ⇒ writeMemory uses deterministic fallback. */
  summarizerTransport?: SummarizerTransport;
```

And add the type import to the existing summarizer import line:

```ts
import { Summarizer, type SummarizerTransport } from './summarizer.ts';
```

- [ ] **Capture each constructed `Summarizer`'s transport** in `buildWorkerOptionsFromEnv`. Alongside the existing `let summarize`, declare:

```ts
  let summarizerTransport: import('./summarizer.ts').SummarizerTransport | undefined;
```

Then in each of the four provider branches (claude-oauth, claude-code, openai-compatible, anthropic), on the line directly after its `summarize = (events) => summarizer.summarize(events);`, add:

```ts
    summarizerTransport = summarizer.getTransport();
```

(Four insertions, one per branch. The deterministic-fallback path covers the no-summarizer `else` branch — no change there.)

- [ ] **Pass it through the returned options object.** In the `return { ... }` of `buildWorkerOptionsFromEnv`, after the existing `...(summarize !== undefined && { summarize }),` line add:

```ts
    ...(summarizerTransport !== undefined && { summarizerTransport }),
```

- [ ] **Add the self-write suppression set + wire the watcher to consume it.** In `startWorker`, just before `let watcher: FileWatcher | null = null;` add:

```ts
  // Paths the writer engine just wrote itself (e.g. POST /remember). chokidar still
  // fires add/change for our own write; we drop the first event per path so we don't
  // re-run indexFile on a file we already indexed in-process. SHA-idempotent anyway,
  // but this avoids a redundant embed+upsert. Single-shot: consumed on first hit.
  const selfWrites = new Set<string>();
  const registerSelfWrite = (absPath: string): void => { selfWrites.add(absPath); };
```

Then in the watcher's `onEvent`, replace:

```ts
          onEvent: async (type, path) => {
            try {
              if (type === 'unlink') await ingest.deleteFile(path);
              else await ingest.indexFile(path, channel);
            } catch (err) {
              console.error(`[watcher] ${type} ${path}: ${(err as Error).message}`);
            }
          },
```

with:

```ts
          onEvent: async (type, path) => {
            try {
              // Suppress the echo of our own in-process write (POST /remember).
              if (type !== 'unlink' && selfWrites.delete(path)) return;
              if (type === 'unlink') await ingest.deleteFile(path);
              else await ingest.indexFile(path, channel);
            } catch (err) {
              console.error(`[watcher] ${type} ${path}: ${(err as Error).message}`);
            }
          },
```

- [ ] **Run the regression suite, expect PASS.** `bun test tests/integration/worker-http.test.ts tests/unit/summarizer-transport.test.ts` → all pass (new getter test + existing http tests).

- [ ] **Commit.**

```
git add src/worker/summarizer.ts src/worker/index.ts tests/unit/summarizer-transport.test.ts
git commit -m "feat(worker): surface SummarizerTransport + self-write set for /remember wiring"
```

---

### Task 8

**Add `POST /remember` route — zod schema, deps builder, `writeMemory` call**

Adds the route the MCP tool and CLI POST to. It zod-parses the body, builds `WriteMemoryDeps` from the in-scope writer-engine instances (`ingest`, `embedder`, `vector`, `meta`, `collectionName`, the new `registerSelfWrite`/`summarizerTransport`), calls `writeMemory(input, deps)`, and returns the structured JSON. No `route-class.ts` change needed: `classifyRoute` already routes unknown POSTs to the writer engine. `searchMemory` maps cosine distance to similarity (`score = 1 - distance`) and scopes to `dir` by `source_path` prefix; under `skipEmbed` it returns `[]` so the writer falls back to filename-collision dedup. The route returns HTTP 200 on `{ok:true}`, 500 on `{ok:false}`, and 400 for zod validation failures only.

- [ ] **Files block.**
  - Modify: `/home/kalin/projects/captain-memo/src/worker/index.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/integration/worker-remember.test.ts` (new — this minimal version is extended in Task 17/18)

- [ ] **Write the failing test.** Create `/home/kalin/projects/captain-memo/tests/integration/worker-remember.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import type { SummarizerTransport } from '../../src/worker/summarizer.ts';

let worker: WorkerHandle;
let port = 0;
let dir = '';

const transport: SummarizerTransport = async () => ({
  content: [{ type: 'text', text: JSON.stringify({
    name: 'Use Bun for all scripts',
    description: 'Project standardizes on Bun over Node.',
    slug: 'use-bun',
    type: 'decision',
  }) }],
  model: 'test-model',
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cm-remember-'));
  worker = await startWorker({
    port: 0,
    projectId: 'test-project',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: ':memory:',
    embeddingDimension: 1024,
    skipEmbed: true,
    summarizerTransport: transport,
  });
  port = worker.port;
});

afterAll(async () => {
  try { await worker.stop(); } catch { /* best-effort */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

test('POST /remember writes a memory file to targetDirOverride and indexes it', async () => {
  const res = await fetch(`http://localhost:${port}/remember`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      body: 'We standardize on Bun for all scripts and tests.',
      type: 'decision',
      targetDirOverride: dir,
    }),
  });
  expect(res.status).toBe(200);
  const out = await res.json() as { ok: boolean; path: string; action: string; doc_id: string };
  expect(out.ok).toBe(true);
  expect(out.action).toBe('created');
  expect(existsSync(out.path)).toBe(true);
  expect(out.path.startsWith(dir)).toBe(true);
  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  expect(files.length).toBe(1);
  const content = readFileSync(out.path, 'utf-8');
  expect(content).toContain('Bun');
});

test('POST /remember rejects a body missing required fields with 400', async () => {
  const res = await fetch(`http://localhost:${port}/remember`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'decision' }),
  });
  expect(res.status).toBe(400);
  const out = await res.json() as { error: string };
  expect(out.error).toBe('invalid_request');
});

test('POST /remember second overlapping call updates in place (one file)', async () => {
  const again = await fetch(`http://localhost:${port}/remember`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      body: 'We standardize on Bun; also use bun test for the suite.',
      type: 'decision',
      slug: 'use-bun',
      targetDirOverride: dir,
    }),
  });
  expect(again.status).toBe(200);
  const out = await again.json() as { ok: boolean; action: string };
  expect(out.ok).toBe(true);
  expect(out.action).toBe('updated');
  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  expect(files.length).toBe(1);
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/integration/worker-remember.test.ts` — the first test fails: `res.status` is 404, not 200.

- [ ] **Wire the imports** in `src/worker/index.ts`. Add to the `from '../shared/paths.ts'` import block:

```ts
  ENV_REMEMBER_DIR,
  DEFAULT_REMEMBER_DIR,
  ENV_REMEMBER_DEDUP_THRESHOLD,
  DEFAULT_REMEMBER_DEDUP_THRESHOLD,
```

And add a new import near the other `./` worker imports:

```ts
import { writeMemory, type WriteMemoryDeps, type RememberInput } from './memory-writer.ts';
```

- [ ] **Add the zod schema** beside the other request schemas (after `RestoreSchema`):

```ts
const RememberSchema = z.object({
  body: z.string().min(1),
  type: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  slug: z.string().optional(),
  cwd: z.string().optional(),
  sourceObservationId: z.number().int().positive().optional(),
  targetDirOverride: z.string().optional(),
});
```

(The wire shape uses a flat `cwd`; the handler nests it into `projectContext.cwd` to match `RememberInput`. MCP/CLI callers send `cwd`, not `projectContext`.)

- [ ] **Add the route handler.** In `src/worker/index.ts`, immediately after the `/reindex` handler's closing `}` (right before the `POST /inject/context` block), insert:

```ts
      if (req.method === 'POST' && url.pathname === '/remember') {
        const parsed = RememberSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }
        const d = parsed.data;

        // Semantic-dedup query: cosine over the memory channel, scoped to `dir` by
        // source_path prefix (the chunker stamps document.source_path = the .md path).
        // Distance → similarity so the score compares against dedupThreshold directly.
        const searchMemory: WriteMemoryDeps['searchMemory'] = async (queryEmbedding, dir, k) => {
          if (opts.skipEmbed || queryEmbedding.length === 0) return [];
          const raw = await vector.query(collectionName, queryEmbedding, Math.max(k * 5, 20));
          const hits: Array<{ source_path: string; score: number; chunk_id: string }> = [];
          for (const r of raw) {
            const lookup = meta.getChunkById(r.id);
            if (!lookup || lookup.document.channel !== 'memory') continue;
            if (!lookup.document.source_path.startsWith(dir)) continue;
            hits.push({ source_path: lookup.document.source_path, score: 1 - r.distance, chunk_id: r.id });
            if (hits.length >= k) break;
          }
          return hits;
        };

        const deps: WriteMemoryDeps = {
          ingest,
          embed: (texts) => embedder.embed(texts),
          searchMemory,
          registerSelfWrite,
          rememberDir: process.env[ENV_REMEMBER_DIR] ?? DEFAULT_REMEMBER_DIR,
          dedupThreshold: Number(process.env[ENV_REMEMBER_DEDUP_THRESHOLD] ?? DEFAULT_REMEMBER_DEDUP_THRESHOLD),
          // Omit `generate` when no transport is configured so writeMemory takes its
          // deterministic frontmatter fallback (name=first line, description=truncated body).
          ...(opts.summarizerTransport !== undefined && { generate: opts.summarizerTransport }),
        } as WriteMemoryDeps;

        const input: RememberInput = {
          body: d.body,
          type: d.type,
          ...(d.name !== undefined && { name: d.name }),
          ...(d.description !== undefined && { description: d.description }),
          ...(d.slug !== undefined && { slug: d.slug }),
          projectContext: { ...(d.cwd !== undefined && { cwd: d.cwd }) },
          ...(d.sourceObservationId !== undefined && { sourceObservationId: d.sourceObservationId }),
          ...(d.targetDirOverride !== undefined && { targetDirOverride: d.targetDirOverride }),
        };

        const result = await writeMemory(input, deps);
        return Response.json(result, { status: result.ok ? 200 : 500 });
      }
```

(The `as WriteMemoryDeps` cast lets the omit-`generate` path compile against the contract's required `generate`; runtime omission triggers the deterministic fallback per spec §5.)

- [ ] **Run it, expect PASS.** `bun test tests/integration/worker-remember.test.ts` → create + 400 + update tests pass (update relies on Task 5's filename-collision dedup, which fires under `skipEmbed`).

- [ ] **Run the broader worker suite, expect PASS.** `bun test tests/integration/worker-http.test.ts tests/integration/worker-remember.test.ts` → all pass.

- [ ] **Commit.**

```
git add src/worker/index.ts tests/integration/worker-remember.test.ts
git commit -m "feat(worker): add POST /remember route + WriteMemoryDeps wiring"
```

---

### Task 9

**MCP `remember` tool — pure request builder + result formatter (TDD, disk/network-free)**

`src/mcp-server.ts` today has no test and its `TOOLS`/handler/`workerPost` are module-private. Following the cross-ai pure-function pattern, export `TOOLS` and add two exported pure helpers (`buildRememberRequest`, `formatRememberResult`) plus the `remember` tool object beside `search_memory`. The tool's inputSchema accepts `body*`, `type*`, `name?`, `description?`, `slug?` — never `cwd`/`projectContext` (the server injects cwd). Success text: `Memory <action>: <path>`; `ok:false` → MCP error `Error: <reason>`.

- [ ] **Files block.**
  - Modify: `/home/kalin/projects/captain-memo/src/mcp-server.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/unit/mcp-remember.test.ts` (new)

- [ ] **Write the failing test.** Create `/home/kalin/projects/captain-memo/tests/unit/mcp-remember.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { TOOLS, buildRememberRequest, formatRememberResult } from '../../src/mcp-server.ts';

test('remember tool is registered beside search_memory', () => {
  const names = TOOLS.map((t) => t.name);
  expect(names).toContain('remember');
  expect(names).toContain('search_memory');
});

test('remember inputSchema requires body + type, allows name/description/slug, no cwd field', () => {
  const remember = TOOLS.find((t) => t.name === 'remember')!;
  expect(remember.inputSchema.type).toBe('object');
  expect(remember.inputSchema.required).toEqual(['body', 'type']);
  const props = remember.inputSchema.properties as Record<string, unknown>;
  expect(Object.keys(props).sort()).toEqual(
    ['body', 'description', 'name', 'slug', 'type'].sort(),
  );
  expect(props).not.toHaveProperty('cwd');
  expect(props).not.toHaveProperty('projectContext');
});

test('remember description steers toward durable curated memory (not scratch)', () => {
  const remember = TOOLS.find((t) => t.name === 'remember')!;
  const d = remember.description.toLowerCase();
  expect(d).toContain('durable');
  expect(d).toContain('memory');
});

test('buildRememberRequest injects projectContext.cwd from the given cwd', () => {
  const body = buildRememberRequest(
    { body: 'Use Bun, not Node, for this repo.', type: 'decision' },
    '/home/kalin/projects/captain-memo',
  );
  expect(body).toEqual({
    body: 'Use Bun, not Node, for this repo.',
    type: 'decision',
    projectContext: { cwd: '/home/kalin/projects/captain-memo' },
  });
});

test('buildRememberRequest forwards optional overrides verbatim and does not invent keys', () => {
  const body = buildRememberRequest(
    { body: 'b', type: 'preference', name: 'N', description: 'D', slug: 'my-slug' },
    '/tmp/proj',
  );
  expect(body).toEqual({
    body: 'b',
    type: 'preference',
    name: 'N',
    description: 'D',
    slug: 'my-slug',
    projectContext: { cwd: '/tmp/proj' },
  });
});

test('buildRememberRequest omits absent optionals (no undefined keys leak to the worker)', () => {
  const body = buildRememberRequest({ body: 'b', type: 'reference' }, '/tmp/proj') as Record<string, unknown>;
  expect('name' in body).toBe(false);
  expect('description' in body).toBe(false);
  expect('slug' in body).toBe(false);
});

test('formatRememberResult on created returns action + path text', () => {
  const out = formatRememberResult({ ok: true, path: '/p/feedback_x.md', action: 'created', doc_id: 'd1' });
  expect(out.isError).toBeUndefined();
  const text = out.content[0]!.text;
  expect(text).toContain('created');
  expect(text).toContain('/p/feedback_x.md');
});

test('formatRememberResult on updated returns action + path text', () => {
  const out = formatRememberResult({ ok: true, path: '/p/decision_y.md', action: 'updated', doc_id: 'd2' });
  expect(out.content[0]!.text).toContain('updated');
  expect(out.content[0]!.text).toContain('/p/decision_y.md');
});

test('formatRememberResult on ok:false surfaces the reason as an MCP error', () => {
  const out = formatRememberResult({ ok: false, reason: 'EACCES: permission denied' });
  expect(out.isError).toBe(true);
  expect(out.content[0]!.text).toContain('EACCES: permission denied');
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/unit/mcp-remember.test.ts` — `SyntaxError: Export named 'buildRememberRequest' not found in module '.../src/mcp-server.ts'` (and `TOOLS`, `formatRememberResult`).

- [ ] **Export `TOOLS` and add the `remember` entry.** In `src/mcp-server.ts`, change the array declaration from `const TOOLS = [` to `export const TOOLS = [`, and insert the `remember` tool object immediately after the `search_memory` block (before the `search_skill` block):

```ts
  {
    name: 'remember',
    description:
      'Persist a durable, curated memory entry worth recalling in future sessions — a decision, preference, convention, or hard-won fact — NOT ephemeral scratch or transient task state. Writes a markdown entry into the current project\'s curated memory and indexes it immediately. Provide the substance in `body` and a `type` (e.g. decision, preference, feedback, reference); `name`, `description`, and `slug` are optional and auto-generated when omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string' },
        type: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        slug: { type: 'string' },
      },
      required: ['body', 'type'],
    },
  },
```

- [ ] **Add the two pure helpers.** Insert immediately before the `export async function runMcpServer()` declaration:

```ts
/** Arguments the `remember` MCP tool accepts from the model (cwd is injected, not accepted). */
export interface RememberToolArgs {
  body: string;
  type: string;
  name?: string;
  description?: string;
  slug?: string;
}

/** Worker `POST /remember` response — mirrors WriteMemoryResult (src/worker/memory-writer.ts). */
type RememberWorkerResult =
  | { ok: true; path: string; action: 'created' | 'updated'; doc_id: string }
  | { ok: false; reason: string };

/** Build the `POST /remember` request body: forward the model's fields verbatim and
 *  inject the session's project cwd. Absent optionals are omitted (no `undefined` keys). */
export function buildRememberRequest(
  args: RememberToolArgs,
  cwd: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    body: args.body,
    type: args.type,
    projectContext: { cwd },
  };
  if (args.name !== undefined) out.name = args.name;
  if (args.description !== undefined) out.description = args.description;
  if (args.slug !== undefined) out.slug = args.slug;
  return out;
}

/** Turn a worker WriteMemoryResult into the model-facing MCP tool response.
 *  Success → action + path text; ok:false → an MCP error carrying the reason. */
export function formatRememberResult(
  result: RememberWorkerResult,
): { content: { type: 'text'; text: string }[]; isError?: true } {
  if (!result.ok) {
    return {
      content: [{ type: 'text', text: `Error: ${result.reason}` }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: `Memory ${result.action}: ${result.path}` }],
  };
}
```

Note: the contract's `projectContext.cwd` here is for the worker wire body. The flat `cwd` field in `RememberSchema` (Task 8) is what the CLI/worker route accept; the MCP tool sends `projectContext.cwd` directly — the worker's `RememberSchema` accepts both shapes only if `cwd` is flat. RECONCILE: the worker route in Task 8 nests a flat `cwd`; to keep one wire contract, the MCP `buildRememberRequest` here sends `projectContext: { cwd }` and the worker handler reads `d.cwd`. To unify, the MCP helper MUST send a flat `cwd`. Apply this correction now: change `projectContext: { cwd }` to `cwd` in `buildRememberRequest` and update the two `buildRememberRequest` tests above to expect `{ body, type, cwd }` instead of `{ body, type, projectContext: { cwd } }`. (Binding decision: the single wire shape is flat `cwd`, matching Task 8's `RememberSchema`.)

- [ ] **Run it, expect PASS.** `bun test tests/unit/mcp-remember.test.ts` → all assertions pass.

- [ ] **Commit.**

```
git add src/mcp-server.ts tests/unit/mcp-remember.test.ts
git commit -m "feat(mcp): add remember tool registration + pure request/result helpers"
```

---

### Task 10

**MCP `remember` handler — inject `process.cwd()`, POST `/remember`, return action+path**

Wire the `remember` tool into the live `CallToolRequestSchema` handler via an exported, injectable `dispatchRemember(args, { post, cwd })`. `workerPost` already throws on non-2xx (handled by the existing try/catch → MCP error), so the only new concern is the app-level `{ ok:false, reason }`, which `formatRememberResult` turns into an MCP error.

- [ ] **Files block.**
  - Modify: `/home/kalin/projects/captain-memo/src/mcp-server.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/unit/mcp-remember.test.ts` (append)

- [ ] **Write the failing test.** Append to `/home/kalin/projects/captain-memo/tests/unit/mcp-remember.test.ts`:

```ts
import { dispatchRemember } from '../../src/mcp-server.ts';

test('dispatchRemember injects cwd, posts /remember, returns formatted created result', async () => {
  const calls: { path: string; body: unknown }[] = [];
  const post = async (path: string, body: unknown) => {
    calls.push({ path, body });
    return { ok: true, path: '/proj/.../memory/decision_use-bun.md', action: 'created', doc_id: 'd9' };
  };
  const out = await dispatchRemember(
    { body: 'Use Bun.', type: 'decision' },
    { post, cwd: () => '/home/kalin/projects/captain-memo' },
  );
  expect(calls).toEqual([
    {
      path: '/remember',
      body: {
        body: 'Use Bun.',
        type: 'decision',
        cwd: '/home/kalin/projects/captain-memo',
      },
    },
  ]);
  expect(out.isError).toBeUndefined();
  expect(out.content[0]!.text).toContain('created');
  expect(out.content[0]!.text).toContain('decision_use-bun.md');
});

test('dispatchRemember surfaces worker ok:false as an MCP error', async () => {
  const post = async () => ({ ok: false, reason: 'ENOSPC: no space left on device' });
  const out = await dispatchRemember(
    { body: 'b', type: 'reference' },
    { post, cwd: () => '/tmp/p' },
  );
  expect(out.isError).toBe(true);
  expect(out.content[0]!.text).toContain('ENOSPC: no space left on device');
});
```

(The expected wire body is flat `cwd` per the binding decision in Task 9.)

- [ ] **Run it, expect FAIL.** `bun test tests/unit/mcp-remember.test.ts` — `Export named 'dispatchRemember' not found in module '.../src/mcp-server.ts'`.

- [ ] **Add the exported `dispatchRemember` orchestrator.** Insert directly after `formatRememberResult`:

```ts
/** Orchestrate the remember tool: inject cwd, POST /remember, format the result.
 *  `deps` is injectable so unit tests need neither a live worker nor the real cwd. */
export async function dispatchRemember(
  args: RememberToolArgs,
  deps: {
    post: (path: string, body: unknown) => Promise<unknown>;
    cwd: () => string;
  },
): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
  const body = buildRememberRequest(args, deps.cwd());
  const result = (await deps.post('/remember', body)) as RememberWorkerResult;
  return formatRememberResult(result);
}
```

- [ ] **Wire the live handler.** Add this case inside the switch's `try` block, immediately after the `case 'reindex':` line and before `case 'stats': {`:

```ts
        case 'remember':
          return await dispatchRemember(args as RememberToolArgs, {
            post: workerPost,
            cwd: () => process.cwd(),
          });
```

(The early return is intentional — `dispatchRemember`'s output already carries `content`/`isError`; transport errors still propagate to the existing `catch (err)`.)

- [ ] **Run it, expect PASS.** `bun test tests/unit/mcp-remember.test.ts` → every test passes, including the two `dispatchRemember` cases.

- [ ] **Sanity-check the MCP surface, expect PASS.** `bun test tests/unit/mcp-remember.test.ts tests/unit/cross-ai.test.ts` → all pass.

- [ ] **Commit.**

```
git add src/mcp-server.ts tests/unit/mcp-remember.test.ts
git commit -m "feat(mcp): wire remember handler — inject process.cwd(), POST /remember"
```

---

### Task 11

**CLI `remember` — pure arg parser (`parseRememberArgs`) with failing unit test**

Mirror the testable-parse pattern (`install.ts` exports `parseInstallOptions`). Create `src/cli/commands/remember.ts` with a pure `parseRememberArgs(args)` that collects `--type` (required), `--name`/`--description`/`--slug` (optional), and the body sources `--body`/`--file` (stdin is the fallback, resolved later). Body is NOT resolved here — the parser only records which source was requested. Rejects unknown flags and `--body`+`--file` together.

- [ ] **Files block.**
  - Create: `/home/kalin/projects/captain-memo/src/cli/commands/remember.ts` (parser portion only)
  - Test: `/home/kalin/projects/captain-memo/tests/unit/cli/remember-args.test.ts` (new)

- [ ] **Write the failing test.** Create `/home/kalin/projects/captain-memo/tests/unit/cli/remember-args.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { parseRememberArgs } from '../../../src/cli/commands/remember.ts';

test('parseRememberArgs — collects type/name/description/slug flags', () => {
  const r = parseRememberArgs([
    '--type', 'decision',
    '--name', 'Use Bun',
    '--description', 'We standardized on Bun',
    '--slug', 'use-bun',
    '--body', 'Bun is the runtime.',
  ]);
  expect(r.type).toBe('decision');
  expect(r.name).toBe('Use Bun');
  expect(r.description).toBe('We standardized on Bun');
  expect(r.slug).toBe('use-bun');
  expect(r.bodyInline).toBe('Bun is the runtime.');
  expect(r.file).toBeUndefined();
});

test('parseRememberArgs — --file records the path, not the contents', () => {
  const r = parseRememberArgs(['--type', 'reference', '--file', '/tmp/note.md']);
  expect(r.file).toBe('/tmp/note.md');
  expect(r.bodyInline).toBeUndefined();
});

test('parseRememberArgs — no body flag leaves bodyInline and file undefined (stdin fallback)', () => {
  const r = parseRememberArgs(['--type', 'feedback']);
  expect(r.bodyInline).toBeUndefined();
  expect(r.file).toBeUndefined();
});

test('parseRememberArgs — missing --type throws (type is required)', () => {
  expect(() => parseRememberArgs(['--body', 'x'])).toThrow(/--type/);
});

test('parseRememberArgs — unknown flag throws', () => {
  expect(() => parseRememberArgs(['--type', 'decision', '--bogus', 'x'])).toThrow(/--bogus/);
});

test('parseRememberArgs — --body and --file together throws (one body source)', () => {
  expect(() => parseRememberArgs(['--type', 'decision', '--body', 'x', '--file', '/tmp/y'])).toThrow(/--body.*--file|one body/i);
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/unit/cli/remember-args.test.ts` — `error: Export named 'parseRememberArgs' not found in module .../remember.ts` (or "Cannot find module" since the file is absent). No tests pass.

- [ ] **Minimal implementation.** Create `/home/kalin/projects/captain-memo/src/cli/commands/remember.ts`:

```ts
import { workerPost } from '../client.ts';

export interface RememberArgs {
  type: string;
  name?: string;
  description?: string;
  slug?: string;
  bodyInline?: string;  // from --body
  file?: string;        // from --file (path; contents read in the command wrapper)
}

class RememberArgError extends Error {}

// Pull the value following a flag (`--flag value`). Fails loudly if the flag is
// present but its value is missing or looks like another flag — same contract as
// install.ts flagValue, so typos surface immediately.
function flagValue(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (v === undefined || v.startsWith('-')) {
    throw new RememberArgError(`${flag} requires a value (e.g. \`${flag} <value>\`).`);
  }
  return v;
}

// Pure flag parser — no I/O. Body resolution (file read / stdin) happens in the
// command wrapper, so this is unit-testable in isolation (cf. parseInstallOptions).
export function parseRememberArgs(args: string[]): RememberArgs {
  let type: string | undefined;
  let name: string | undefined;
  let description: string | undefined;
  let slug: string | undefined;
  let bodyInline: string | undefined;
  let file: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--type':        type = flagValue(args, i, '--type'); i++; break;
      case '--name':        name = flagValue(args, i, '--name'); i++; break;
      case '--description': description = flagValue(args, i, '--description'); i++; break;
      case '--slug':        slug = flagValue(args, i, '--slug'); i++; break;
      case '--body':        bodyInline = flagValue(args, i, '--body'); i++; break;
      case '--file':        file = flagValue(args, i, '--file'); i++; break;
      default:
        throw new RememberArgError(`Unknown remember flag: ${arg}`);
    }
  }

  if (type === undefined) {
    throw new RememberArgError('--type is required (e.g. --type decision|feedback|reference|preference).');
  }
  if (bodyInline !== undefined && file !== undefined) {
    throw new RememberArgError('Pass only one body source: --body, --file, or stdin (not --body and --file together).');
  }

  return { type, name, description, slug, bodyInline, file };
}

export { RememberArgError };
```

- [ ] **Run it, expect PASS.** `bun test tests/unit/cli/remember-args.test.ts` → `6 pass, 0 fail`.

- [ ] **Commit.**

```
git add src/cli/commands/remember.ts tests/unit/cli/remember-args.test.ts
git commit -m "feat(cli): add parseRememberArgs flag parser for remember command"
```

---

### Task 12

**CLI `remember` — body resolution + worker POST + non-zero exit on failure**

Add `readBody(parsed)` (precedence: `--body` inline → `--file` contents → stdin) and the thin command wrapper `rememberCommand(args)` following `reindexCommand`. It injects `cwd` (flat field, matching Task 8's `RememberSchema`), POSTs `/remember`, prints the result, and returns a numeric exit code (0 ok, 1 on `{ok:false}`, 2 on arg/body errors). `workerPost` throws on non-2xx, so a `{ok:false}` body is reached only when the worker returns HTTP 200+`{ok:false}` — but the route returns 500 on `{ok:false}`, so `workerPost` throws and the CLI's catch in `index.ts` yields a non-zero exit. RECONCILE/binding: `rememberCommand` wraps the `workerPost` call in try/catch and returns 1 with the error message, so both the 500-throw path and any 200+`{ok:false}` path produce a visible reason + non-zero exit.

- [ ] **Files block.**
  - Modify: `/home/kalin/projects/captain-memo/src/cli/commands/remember.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/unit/cli/remember-args.test.ts` (append)

- [ ] **Write the failing test.** Append to `/home/kalin/projects/captain-memo/tests/unit/cli/remember-args.test.ts`:

```ts
import { readBody } from '../../../src/cli/commands/remember.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

test('readBody — inline --body wins and is returned verbatim', async () => {
  const out = await readBody({ type: 'decision', bodyInline: 'inline text' });
  expect(out).toBe('inline text');
});

test('readBody — --file reads the file contents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-remember-'));
  const fp = join(dir, 'note.md');
  writeFileSync(fp, '# A decision\nbody from file');
  try {
    const out = await readBody({ type: 'decision', file: fp });
    expect(out).toBe('# A decision\nbody from file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readBody — missing --file path throws an actionable error', async () => {
  await expect(readBody({ type: 'decision', file: '/no/such/path-xyz.md' })).rejects.toThrow(/no\/such\/path-xyz\.md|read|file/i);
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/unit/cli/remember-args.test.ts` — `Export named 'readBody' not found in module .../remember.ts`. The 6 parser tests still pass; the 3 new ones error.

- [ ] **Minimal implementation.** Append to `/home/kalin/projects/captain-memo/src/cli/commands/remember.ts` (after `export { RememberArgError };`):

```ts
import { readFileSync } from 'fs';

// Resolve the body text: inline --body, else --file contents, else stdin.
// Exported so the source-precedence + file-read is unit-testable without a worker.
export async function readBody(parsed: RememberArgs): Promise<string> {
  if (parsed.bodyInline !== undefined) return parsed.bodyInline;
  if (parsed.file !== undefined) {
    try {
      return readFileSync(parsed.file, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RememberArgError(`Could not read --file ${parsed.file}: ${msg}`);
    }
  }
  // Fall back to stdin (piped body). new Response(...).text() drains Bun's stdin stream.
  const stdin = await new Response(Bun.stdin.stream()).text();
  return stdin;
}

interface RememberResult {
  ok: boolean;
  path?: string;
  action?: 'created' | 'updated';
  doc_id?: string;
  reason?: string;
}

export async function rememberCommand(args: string[]): Promise<number> {
  let parsed: RememberArgs;
  try {
    parsed = parseRememberArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  let body: string;
  try {
    body = await readBody(parsed);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (body.trim() === '') {
    console.error('Empty body. Provide content via --body <text>, --file <path>, or piped stdin.');
    return 2;
  }

  const payload: Record<string, unknown> = {
    body,
    type: parsed.type,
    cwd: process.cwd(),
  };
  if (parsed.name !== undefined) payload.name = parsed.name;
  if (parsed.description !== undefined) payload.description = parsed.description;
  if (parsed.slug !== undefined) payload.slug = parsed.slug;

  let result: RememberResult;
  try {
    result = await workerPost('/remember', payload) as RememberResult;
  } catch (err) {
    console.error(`remember failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (!result.ok) {
    console.error(`remember failed: ${result.reason ?? '(no reason given)'}`);
    return 1;
  }
  console.log(`Remembered (${result.action}):`);
  console.log(`  path:   ${result.path}`);
  console.log(`  doc_id: ${result.doc_id}`);
  return 0;
}
```

(The payload uses a flat `cwd` field — the binding wire shape from Task 8.)

- [ ] **Run it, expect PASS.** `bun test tests/unit/cli/remember-args.test.ts` → `9 pass, 0 fail`.

- [ ] **Commit.**

```
git add src/cli/commands/remember.ts tests/unit/cli/remember-args.test.ts
git commit -m "feat(cli): resolve remember body (body/file/stdin), POST /remember, non-zero exit on {ok:false}"
```

---

### Task 13

**Register `remember` in the CLI dispatcher and help text**

Wire the command into `src/cli/index.ts`: an import line, a `case` in the dispatch `switch`, and entries in the `HELP` command list + examples.

- [ ] **Files block.**
  - Modify: `/home/kalin/projects/captain-memo/src/cli/index.ts`

- [ ] **Add the import.** After the `import { dedupCommand } from './commands/dedup.ts';` line, insert:

```ts
import { rememberCommand } from './commands/remember.ts';
```

- [ ] **Add the dispatch case.** After the `reindex` case (the block `case 'reindex':\n      exit = await reindexCommand(args.slice(1));\n      break;`), insert:

```ts
    case 'remember':
      exit = await rememberCommand(args.slice(1));
      break;
```

- [ ] **Add the HELP command-list line.** In the `Commands:` block, after the `reindex` line, insert:

```
  remember     Persist a curated memory entry (--type, body via --body/--file/stdin)
```

- [ ] **Add HELP examples.** In the `Examples:` block, after `  captain-memo reindex --force`, insert:

```
  captain-memo remember --type decision --body "We standardized on Bun"
  echo "long note" | captain-memo remember --type reference --name "API notes"
```

- [ ] **Verify help registration (no worker needed).** `bun src/cli/index.ts help` — expected: the banner prints, the `Commands:` list contains the `remember` line, and the two `remember` examples appear under `Examples:`. No error.

- [ ] **Verify dispatch routes to the command.** `bun src/cli/index.ts remember --bogus 2>&1; echo "exit=$?"` — expected: prints `Unknown remember flag: --bogus` and `exit=2` (confirms dispatch to `rememberCommand`, not the `Unknown command` default).

- [ ] **Run the unit suite, expect PASS.** `bun test tests/unit/cli/remember-args.test.ts` → `9 pass, 0 fail`.

- [ ] **Commit.**

```
git add src/cli/index.ts
git commit -m "feat(cli): register remember command in dispatcher and help text"
```

---

### Task 14

**Add v11 `promoted_at` migration to the observations store (idempotency column)**

Adds the provenance/idempotency column the promotion job uses to never promote the same observation twice. Follows the v8/v9/v10 migration pattern (`OBSERVATIONS_STORE_MIGRATIONS` entry + partial index) and updates the schema-count assertion that lists the full migration set. Spec §7 offered "a `promoted_at` column OR a small promotions table"; the binding choice is the **column** (single ALTER + partial index), mirroring the existing v6/v8 nullable-column + partial-index precedent.

- [ ] **Files block.**
  - Modify: `/home/kalin/projects/captain-memo/src/worker/observations-store.ts`
  - Modify: `/home/kalin/projects/captain-memo/tests/unit/observations-store.test.ts`

- [ ] **Write the failing migration test.** In `tests/unit/observations-store.test.ts`, immediately after the v10 test (`migration v10 adds qm_runs audit table`), add:

```ts
test('ObservationsStore — migration v11 adds promoted_at column + partial index', () => {
  const db = new Database(join(workDir, 'observations.db'));
  const cols = db.query('PRAGMA table_info(observations)').all() as Array<{ name: string; dflt_value: unknown }>;
  const byName = new Map(cols.map(c => [c.name, c]));

  expect(byName.has('promoted_at')).toBe(true);
  expect(byName.get('promoted_at')!.dflt_value).toBeNull();

  const idx = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_obs_promoted'").all();
  expect(idx.length).toBe(1);

  expect(getAppliedVersions(db).some(v => v.version === 11)).toBe(true);
  db.close();
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/unit/observations-store.test.ts -t "migration v11"` — fails: `expect(byName.has('promoted_at')).toBe(true)` is `false`, and the v11 applied check is `false`.

- [ ] **Add the v11 migration.** In `src/worker/observations-store.ts`, inside `OBSERVATIONS_STORE_MIGRATIONS`, after the v10 `add_qm_runs` entry (before the closing `];`), append:

```ts
{
  // v11 — promotion provenance/idempotency. `promoted_at` (epoch seconds) is
  // stamped the moment the opt-in promotion job folds an observation into a
  // curated memory file, so a later run can exclude it and never promote the
  // same row twice. NULL = never promoted; the candidate query filters on it.
  // Partial index mirrors the v6/v8 trick — only the promoted minority is
  // indexed, so the default (promoted_at IS NULL) majority stays index-free.
  // Spec: docs/superpowers/specs/2026-06-13-captain-remember-design.md §7.
  version: 11,
  name: 'add_promoted_at',
  up: (db) => {
    db.exec('ALTER TABLE observations ADD COLUMN promoted_at INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS idx_obs_promoted ON observations(promoted_at) WHERE promoted_at IS NOT NULL');
  },
},
```

- [ ] **Run it, expect PASS.** `bun test tests/unit/observations-store.test.ts -t "migration v11"` → 1 pass.

- [ ] **Fix the stale full-list assertion.** In the `schema_versions records all migrations after construction` test, change `expect(rows).toHaveLength(10);` to `expect(rows).toHaveLength(11);`, change `expect(rows.map(r => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);` to `expect(rows.map(r => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);`, and add `'add_promoted_at',` as the last entry of the `expect(rows.map(r => r.name)).toEqual([...])` array (after `'add_qm_runs',`).

- [ ] **Run the full observations-store suite, expect PASS.** `bun test tests/unit/observations-store.test.ts` → all pass.

- [ ] **Commit.**

```
git add src/worker/observations-store.ts tests/unit/observations-store.test.ts
git commit -m "feat(obs): add v11 promoted_at migration for promotion idempotency"
```

---

### Task 15

**Add promotion store methods — candidate select + mark-promoted (idempotent)**

Adds `promotionCandidates(opts)` (durable types `decision`/`feature`/`discovery`, recall-count `from_auto + from_search + from_drill >= minRecall`, excluding archived and already-promoted rows) and `markPromoted(id, atEpoch)` (stamps the v11 column).

- [ ] **Files block.**
  - Modify: `/home/kalin/projects/captain-memo/src/worker/observations-store.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/unit/observations-store.test.ts` (append)

- [ ] **Write the failing tests.** Append to `tests/unit/observations-store.test.ts` (after the v11 migration test):

```ts
test('promotionCandidates — durable types + recall-count, excludes promoted', () => {
  const base = { session_id: 's', project_id: 'p', prompt_number: 1, narrative: 'n',
    facts: [], concepts: [], files_read: [], files_modified: [],
    created_at_epoch: 1_700_000_000, branch: null, work_tokens: null };
  const durable = store.insert({ ...base, type: 'decision', title: 'durable hot' });
  const ephemeral = store.insert({ ...base, type: 'change', title: 'ephemeral hot' });
  const durableCold = store.insert({ ...base, type: 'feature', title: 'durable cold' });
  const durablePromoted = store.insert({ ...base, type: 'discovery', title: 'already promoted' });
  store.bumpRetrieval([durable], 'search', 1_700_000_100);
  store.bumpRetrieval([durablePromoted], 'drill', 1_700_000_100);
  store.markPromoted(durablePromoted, 1_700_000_200);

  const ids = store.promotionCandidates({ limit: 50, minRecall: 1 }).map(o => o.id);
  expect(ids).toContain(durable);
  expect(ids).not.toContain(ephemeral);
  expect(ids).not.toContain(durableCold);
  expect(ids).not.toContain(durablePromoted);
});

test('markPromoted — sets promoted_at and is idempotent on re-call', () => {
  const id = store.insert({ session_id: 's', project_id: 'p', prompt_number: 1,
    type: 'decision', title: 't', narrative: 'n', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 1_700_000_000,
    branch: null, work_tokens: null });
  store.bumpRetrieval([id], 'search', 1_700_000_100);
  store.markPromoted(id, 1_700_000_200);
  store.markPromoted(id, 1_700_000_300);
  expect(store.promotionCandidates({ limit: 50, minRecall: 1 }).map(o => o.id)).not.toContain(id);
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/unit/observations-store.test.ts -t "promotionCandidates"` — `store.promotionCandidates is not a function` (and `markPromoted` undefined).

- [ ] **Implement both methods.** In `src/worker/observations-store.ts`, inside `class ObservationsStore`, after `listByTideState`, add:

```ts
/**
 * Bounded candidate set for the opt-in promotion job. Returns the most-recent
 * `limit` observations restricted to DURABLE types (decision/feature/discovery
 * — spec §7) that carry a recall signal (from_auto + from_search + from_drill ≥
 * minRecall) and have NOT already been promoted (promoted_at IS NULL). Archived
 * rows are excluded — a folded duplicate is represented by its survivor. The
 * promotion slice judges these further; this only narrows the corpus cheaply.
 */
promotionCandidates(opts: { limit: number; minRecall: number }): Observation[] {
  const rows = this.db
    .query(
      `SELECT * FROM observations
        WHERE promoted_at IS NULL
          AND archived = 0
          AND type IN ('decision', 'feature', 'discovery')
          AND (from_auto + from_search + from_drill) >= ?
        ORDER BY created_at_epoch DESC, id DESC
        LIMIT ?`,
    )
    .all(opts.minRecall, opts.limit) as Array<Record<string, unknown>>;
  return rows.map(r => this.hydrate(r));
}

/** Stamp an observation as promoted (epoch seconds) so it is never promoted
 *  again. Idempotent: re-stamping just overwrites the timestamp; the row is
 *  already excluded from promotionCandidates by the promoted_at IS NULL filter. */
markPromoted(id: number, atEpoch: number): void {
  this.db
    .query('UPDATE observations SET promoted_at = ? WHERE id = ?')
    .run(atEpoch, id);
}
```

- [ ] **Run it, expect PASS.** `bun test tests/unit/observations-store.test.ts -t "promotionCandidates"` and `bun test tests/unit/observations-store.test.ts -t "markPromoted"` → both pass.

- [ ] **Commit.**

```
git add src/worker/observations-store.ts tests/unit/observations-store.test.ts
git commit -m "feat(obs): promotionCandidates + markPromoted store methods"
```

---

### Task 16

**Add promotion config (`loadPromotionConfig`) — opt-in, off by default**

Adds a pure `loadPromotionConfig(env)` mirroring `loadQmConfig` (asymmetric boolean: enable only on `'1'`; numeric parse with default fallback, never NaN). Reads the env constants from Task 1.

- [ ] **Files block.**
  - Create: `/home/kalin/projects/captain-memo/src/worker/promotion-config.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/unit/worker/promotion-config.test.ts` (new)

- [ ] **Write the failing test.** Create `/home/kalin/projects/captain-memo/tests/unit/worker/promotion-config.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { DEFAULT_PROMOTION_CONFIG, loadPromotionConfig } from '../../../src/worker/promotion-config.ts';

test('defaults: promotion OFF, 6h interval, max 5 per run, minRecall 1', () => {
  expect(DEFAULT_PROMOTION_CONFIG.enabled).toBe(false);
  expect(DEFAULT_PROMOTION_CONFIG.intervalMs).toBe(21_600_000);
  expect(DEFAULT_PROMOTION_CONFIG.maxPerRun).toBe(5);
  expect(DEFAULT_PROMOTION_CONFIG.minRecall).toBe(1);
});

test('loadPromotionConfig with empty env equals defaults', () => {
  expect(loadPromotionConfig({})).toEqual(DEFAULT_PROMOTION_CONFIG);
});

test('opt-in only on explicit "1"', () => {
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_ENABLE: '1' }).enabled).toBe(true);
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_ENABLE: '0' }).enabled).toBe(false);
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_ENABLE: 'true' }).enabled).toBe(false);
});

test('numeric override + invalid falls back to default', () => {
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN: '3' }).maxPerRun).toBe(3);
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN: 'nonsense' }).maxPerRun).toBe(5);
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_INTERVAL_MS: '1000' }).intervalMs).toBe(1000);
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/unit/worker/promotion-config.test.ts` — fails to resolve `../../../src/worker/promotion-config.ts` (module does not exist).

- [ ] **Implement the config module.** Create `/home/kalin/projects/captain-memo/src/worker/promotion-config.ts`:

```ts
// src/worker/promotion-config.ts — pure config for the opt-in promotion job.
// No I/O beyond reading a plain env record (mirrors qm.ts/loadQmConfig). The
// job promotes durable, high-signal observations into curated memory via the
// shared writeMemory() path; it is OFF by default (a write to the user's memory
// dir), so enable is asymmetric: ON only on explicit '1'. Spec §7/§8.
import {
  DEFAULT_PROMOTE_INTERVAL_MS,
  DEFAULT_PROMOTE_MAX_PER_RUN,
  ENV_PROMOTE_ENABLE,
  ENV_PROMOTE_INTERVAL_MS,
  ENV_PROMOTE_MAX_PER_RUN,
} from '../shared/paths.ts';

export interface PromotionConfig {
  /** Master switch. Default OFF; set CAPTAIN_MEMO_PROMOTE_ENABLE=1 to enable. */
  enabled: boolean;
  /** ms between promotion ticks. */
  intervalMs: number;
  /** Per-run promotion cap. */
  maxPerRun: number;
  /** Minimum recall signal (from_auto + from_search + from_drill) for a row to
   *  be a candidate. Importance gate, mirrors spec §7 "recall-count ≥ k". */
  minRecall: number;
}

export const DEFAULT_PROMOTION_CONFIG: PromotionConfig = {
  enabled: false,
  intervalMs: DEFAULT_PROMOTE_INTERVAL_MS,
  maxPerRun: DEFAULT_PROMOTE_MAX_PER_RUN,
  minRecall: 1,
};

/** Build a PromotionConfig from a plain env record. Unparseable numeric values
 *  fall back to the default (never NaN). enabled is ON only on explicit '1'. */
export function loadPromotionConfig(env: Record<string, string | undefined>): PromotionConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
  };
  const D = DEFAULT_PROMOTION_CONFIG;
  return {
    enabled: env[ENV_PROMOTE_ENABLE] === '1',
    intervalMs: num(env[ENV_PROMOTE_INTERVAL_MS], D.intervalMs),
    maxPerRun: num(env[ENV_PROMOTE_MAX_PER_RUN], D.maxPerRun),
    minRecall: D.minRecall,
  };
}
```

- [ ] **Run it, expect PASS.** `bun test tests/unit/worker/promotion-config.test.ts` → 4 pass.

- [ ] **Commit.**

```
git add src/worker/promotion-config.ts tests/unit/worker/promotion-config.test.ts
git commit -m "feat(promote): loadPromotionConfig (opt-in, off by default)"
```

---

### Task 17

**Promotion slice (`runPromotionSlice`) — pure judge + write + mark, capped**

The heart of the job. Pure orchestrator over injected deps (mirrors `runQmDedupSlice`): pulls candidates, runs ONE `generate` judge pass deciding curated-worthy vs ephemeral, calls `writeMemory` per survivor (with `sourceObservationId`, NO cwd ⇒ falls through to `deps.rememberDir`), marks promoted on a successful write only, caps at `maxPerRun`, logs every promote/skip. Off unless `cfg.enabled`. Imports `RememberInput`/`WriteMemoryResult` type-only (memory-writer.ts already exists from Tasks 3-6).

- [ ] **Files block.**
  - Create: `/home/kalin/projects/captain-memo/src/worker/promotion.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/unit/promotion.test.ts` (new)

- [ ] **Write the first failing tests.** Create `/home/kalin/projects/captain-memo/tests/unit/promotion.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { runPromotionSlice, type PromotionDeps } from '../../src/worker/promotion.ts';
import { DEFAULT_PROMOTION_CONFIG, type PromotionConfig } from '../../src/worker/promotion-config.ts';
import type { Observation } from '../../src/shared/types.ts';
import type { WriteMemoryResult } from '../../src/worker/memory-writer.ts';

const NOW = 1000;

function obs(id: number, over: Partial<Observation> = {}): Observation {
  return {
    id, session_id: 's', project_id: 'default', prompt_number: 1,
    type: 'decision', title: `obs-${id}`, narrative: `narrative ${id}`,
    facts: [`fact ${id}`], concepts: ['c'], files_read: [], files_modified: [],
    created_at_epoch: 1_700_000_000, branch: null, work_tokens: null, stored_tokens: null,
    retrieval_count: 0, last_retrieved_at: null,
    from_auto: 0, from_search: 1, from_drill: 0,
    last_surfaced_at: null, last_surfaced_source: null,
    archived: false, archived_into_theme_id: null, theme_member_ids: null,
    stability_days: null, tide_state: 'active', tide_state_changed_at: null, is_anchored: false,
    ...over,
  } as Observation;
}

interface Rec {
  writes: Array<{ sourceObservationId?: number; type: string; cwd?: string; targetDirOverride?: string }>;
  promoted: number[];
  judgeCalls: number;
}

function makeDeps(
  candidates: Observation[],
  promote: number[],
  over: Partial<PromotionDeps> = {},
): { deps: PromotionDeps; rec: Rec } {
  const rec: Rec = { writes: [], promoted: [], judgeCalls: 0 };
  const cfg: PromotionConfig = { ...DEFAULT_PROMOTION_CONFIG, enabled: true, maxPerRun: 5 };
  const deps: PromotionDeps = {
    candidates: () => candidates,
    judge: async (rows) => {
      rec.judgeCalls++;
      return rows
        .filter(r => promote.includes(r.id))
        .map(r => ({ sourceObservationId: r.id, type: 'decision',
          name: `n-${r.id}`, description: `d-${r.id}`, body: `b-${r.id}` }));
    },
    writeMemory: async (input) => {
      rec.writes.push({ sourceObservationId: input.sourceObservationId, type: input.type,
        cwd: input.projectContext.cwd, targetDirOverride: input.targetDirOverride });
      return { ok: true, path: `/mem/n-${input.sourceObservationId}.md`,
        action: 'created', doc_id: `doc-${input.sourceObservationId}` } as WriteMemoryResult;
    },
    markPromoted: (id) => { rec.promoted.push(id); },
    cfg,
    now: () => NOW,
    log: () => {},
    ...over,
  };
  return { deps, rec };
}

test('runPromotionSlice — off by default: enabled=false consults no candidates', async () => {
  let consulted = false;
  const { deps, rec } = makeDeps([obs(1)], [1], {
    cfg: { ...DEFAULT_PROMOTION_CONFIG, enabled: false },
    candidates: () => { consulted = true; return [obs(1)]; },
  });
  const r = await runPromotionSlice(deps);
  expect(r).toEqual({ scanned: 0, promoted: 0, skipped: 0, errored: 0 });
  expect(consulted).toBe(false);
  expect(rec.judgeCalls).toBe(0);
  expect(rec.writes).toHaveLength(0);
  expect(rec.promoted).toHaveLength(0);
});

test('runPromotionSlice — promotes judged survivors: writes with sourceObservationId + NO cwd, marks promoted', async () => {
  const { deps, rec } = makeDeps([obs(1), obs(2)], [1]);
  const r = await runPromotionSlice(deps);
  expect(r).toEqual({ scanned: 2, promoted: 1, skipped: 1, errored: 0 });
  expect(rec.writes).toEqual([
    { sourceObservationId: 1, type: 'decision', cwd: undefined, targetDirOverride: undefined },
  ]);
  expect(rec.promoted).toEqual([1]);
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/unit/promotion.test.ts` — fails to resolve `../../src/worker/promotion.ts`.

- [ ] **Implement the slice.** Create `/home/kalin/projects/captain-memo/src/worker/promotion.ts`:

```ts
// src/worker/promotion.ts — the pure, heartbeat-safe promotion slice (opt-in).
// Modelled on quartermaster.ts/runQmDedupSlice: pure orchestration over INJECTED
// deps, so it unit-tests with no worker, DB, or real timer. It pulls a bounded
// candidate window of durable, high-signal observations, runs ONE judge pass
// (the "remember forever?" gate — most observations are NOT promoted) that
// distills each survivor into a curated {type,name,description,body}, writes each
// via the shared writeMemory() with sourceObservationId provenance and NO cwd
// (so target resolution falls through to deps.rememberDir), marks it promoted so
// a re-run never re-promotes it, caps at cfg.maxPerRun, and logs every
// promote/skip with a reason. Off unless cfg.enabled.
import type { Observation } from '../shared/types.ts';
import type { RememberInput, WriteMemoryResult } from './memory-writer.ts';
import type { PromotionConfig } from './promotion-config.ts';

/** One judged survivor — the distilled curated entry the judge returns. */
export interface PromotionVerdict {
  sourceObservationId: number;
  type: string;
  name: string;
  description: string;
  body: string;
}

export interface PromotionDeps {
  /** Bounded candidate window (durable types + recall ≥ minRecall, not yet
   *  promoted) — typically obsStore.promotionCandidates(...). */
  candidates: () => Observation[];
  /** ONE judge pass over all candidates: returns ONLY the survivors to promote,
   *  each distilled. The gate — most rows are dropped (absent from the result). */
  judge: (rows: Observation[]) => Promise<PromotionVerdict[]>;
  /** Shared curated-memory writer. The slice passes NO cwd so the target falls
   *  through to deps.rememberDir inside writeMemory. */
  writeMemory: (input: RememberInput) => Promise<WriteMemoryResult>;
  /** Stamp the source observation promoted (idempotency) — obsStore.markPromoted. */
  markPromoted: (id: number, atEpoch: number) => void;
  cfg: PromotionConfig;
  /** Current wall-clock, epoch seconds. Injected for deterministic tests. */
  now: () => number;
  /** Structured logging sink (console.error in prod) — every promote/skip. */
  log: (line: string) => void;
}

export interface PromotionResult {
  scanned: number;  // candidates the judge saw
  promoted: number; // observations written to curated memory + marked
  skipped: number;  // candidates the judge dropped, or writes deduped/failed-soft
  errored: number;  // writes that returned { ok: false }
}

/**
 * Run one promotion slice. Off unless cfg.enabled. Pulls candidates, runs one
 * judge pass, then writes up to cfg.maxPerRun survivors via writeMemory (NO cwd
 * ⇒ rememberDir). A row is marked promoted ONLY on a successful write, so a
 * failed write retries next run (no silent loss); a survivor beyond the cap is
 * left unmarked and picked up next run. Never throws on a single bad write — it
 * logs and counts it.
 */
export async function runPromotionSlice(deps: PromotionDeps): Promise<PromotionResult> {
  const res: PromotionResult = { scanned: 0, promoted: 0, skipped: 0, errored: 0 };
  if (!deps.cfg.enabled) return res; // off by default — consult nothing
  const atEpoch = deps.now();

  const rows = deps.candidates();
  res.scanned = rows.length;
  if (rows.length === 0) return res;

  const verdicts = await deps.judge(rows);
  const keepIds = new Set(verdicts.map(v => v.sourceObservationId));
  for (const r of rows) {
    if (!keepIds.has(r.id)) {
      res.skipped++;
      deps.log(`[promote] skip obs ${r.id} "${r.title}" — judged ephemeral`);
    }
  }

  for (const v of verdicts) {
    if (res.promoted >= deps.cfg.maxPerRun) {
      res.skipped++;
      deps.log(`[promote] skip obs ${v.sourceObservationId} — max-per-run cap (${deps.cfg.maxPerRun}) reached`);
      continue;
    }
    const input: RememberInput = {
      body: v.body,
      type: v.type,
      name: v.name,
      description: v.description,
      projectContext: {}, // NO cwd ⇒ writeMemory targets deps.rememberDir
      sourceObservationId: v.sourceObservationId,
    };
    let result: WriteMemoryResult;
    try {
      result = await deps.writeMemory(input);
    } catch (err) {
      res.errored++;
      deps.log(`[promote] ERROR writing obs ${v.sourceObservationId}: ${(err as Error).message}`);
      continue; // unmarked ⇒ retried next run
    }
    if (!result.ok) {
      res.errored++;
      deps.log(`[promote] write failed for obs ${v.sourceObservationId}: ${result.reason}`);
      continue; // unmarked ⇒ retried next run
    }
    deps.markPromoted(v.sourceObservationId, atEpoch);
    res.promoted++;
    deps.log(`[promote] obs ${v.sourceObservationId} -> ${result.action} ${result.path}`);
  }
  return res;
}
```

- [ ] **Run it, expect PASS.** `bun test tests/unit/promotion.test.ts` → 2 pass.

- [ ] **Add idempotency + cap + soft-fail tests.** Append to `tests/unit/promotion.test.ts`:

```ts
test('runPromotionSlice — idempotency: a promoted row is excluded next run (candidates filter), no re-promote', async () => {
  const all = [obs(1), obs(2)];
  let promotedIds: number[] = [];
  const { deps, rec } = makeDeps(all, [1, 2], {
    candidates: () => all.filter(o => !promotedIds.includes(o.id)),
    markPromoted: (id) => { promotedIds.push(id); rec.promoted.push(id); },
  });
  const first = await runPromotionSlice(deps);
  expect(first.promoted).toBe(2);
  expect(rec.promoted).toEqual([1, 2]);
  const second = await runPromotionSlice(deps);
  expect(second).toEqual({ scanned: 0, promoted: 0, skipped: 0, errored: 0 });
  expect(rec.writes).toHaveLength(2);
});

test('runPromotionSlice — max-per-run cap: only N written, the rest skipped + left unmarked', async () => {
  const rows = [obs(1), obs(2), obs(3)];
  const { deps, rec } = makeDeps(rows, [1, 2, 3], {
    cfg: { ...DEFAULT_PROMOTION_CONFIG, enabled: true, maxPerRun: 2 },
  });
  const r = await runPromotionSlice(deps);
  expect(r.promoted).toBe(2);
  expect(r.skipped).toBe(1);
  expect(rec.writes).toHaveLength(2);
  expect(rec.promoted).toEqual([1, 2]);
});

test('runPromotionSlice — soft write failure: ok:false counts errored, row left unmarked', async () => {
  const { deps, rec } = makeDeps([obs(1)], [1], {
    writeMemory: async () => ({ ok: false, reason: 'disk full' } as WriteMemoryResult),
  });
  const r = await runPromotionSlice(deps);
  expect(r).toEqual({ scanned: 1, promoted: 0, skipped: 0, errored: 1 });
  expect(rec.promoted).toHaveLength(0);
});
```

- [ ] **Run it, expect PASS.** `bun test tests/unit/promotion.test.ts` → 5 pass.

- [ ] **Commit.**

```
git add src/worker/promotion.ts tests/unit/promotion.test.ts
git commit -m "feat(promote): pure runPromotionSlice — judge + write + mark, capped + idempotent"
```

---

### Task 18

**Promotion judge helper (`buildPromotionJudge`) over the SummarizerTransport**

Wraps the `generate: SummarizerTransport` into the `PromotionDeps.judge` function: builds one prompt over all candidates, parses the model's JSON via zod, returns distilled survivors. Fail-safe — empty candidate list never calls the model; a malformed/empty/offline reply yields ZERO survivors; survivors referencing an id not presented are dropped.

- [ ] **Files block.**
  - Create: `/home/kalin/projects/captain-memo/src/worker/promotion-judge.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/unit/promotion-judge.test.ts` (new)

- [ ] **Write the failing test.** Create `/home/kalin/projects/captain-memo/tests/unit/promotion-judge.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { buildPromotionJudge } from '../../src/worker/promotion-judge.ts';
import type { SummarizerTransport } from '../../src/worker/summarizer.ts';
import type { Observation } from '../../src/shared/types.ts';

function obs(id: number): Observation {
  return {
    id, session_id: 's', project_id: 'default', prompt_number: 1,
    type: 'decision', title: `title ${id}`, narrative: `narrative ${id}`,
    facts: [`fact ${id}`], concepts: ['c'], files_read: [], files_modified: [],
    created_at_epoch: 1_700_000_000, branch: null, work_tokens: null, stored_tokens: null,
    retrieval_count: 0, last_retrieved_at: null,
    from_auto: 0, from_search: 1, from_drill: 0,
    last_surfaced_at: null, last_surfaced_source: null,
    archived: false, archived_into_theme_id: null, theme_member_ids: null,
    stability_days: null, tide_state: 'active', tide_state_changed_at: null, is_anchored: false,
  } as Observation;
}

function transportReturning(text: string): SummarizerTransport {
  return async () => ({ content: [{ type: 'text', text }], model: 'test-model' });
}

test('buildPromotionJudge — parses survivors from model JSON, distills fields', async () => {
  const judge = buildPromotionJudge(transportReturning(JSON.stringify({
    promote: [
      { sourceObservationId: 1, type: 'decision', name: 'Use bun:sqlite',
        description: 'Standardized on bun:sqlite', body: 'We chose bun:sqlite for ...' },
    ],
  })));
  const out = await judge([obs(1), obs(2)]);
  expect(out).toEqual([
    { sourceObservationId: 1, type: 'decision', name: 'Use bun:sqlite',
      description: 'Standardized on bun:sqlite', body: 'We chose bun:sqlite for ...' },
  ]);
});

test('buildPromotionJudge — empty candidate list never calls the model, returns []', async () => {
  let called = false;
  const judge = buildPromotionJudge(async () => { called = true; return { content: [{ type: 'text', text: '{}' }], model: 'm' }; });
  expect(await judge([])).toEqual([]);
  expect(called).toBe(false);
});

test('buildPromotionJudge — malformed JSON ⇒ zero survivors (promotes nothing)', async () => {
  const judge = buildPromotionJudge(transportReturning('not json at all'));
  expect(await judge([obs(1)])).toEqual([]);
});

test('buildPromotionJudge — model returns no survivors ⇒ []', async () => {
  const judge = buildPromotionJudge(transportReturning(JSON.stringify({ promote: [] })));
  expect(await judge([obs(1)])).toEqual([]);
});

test('buildPromotionJudge — drops survivors referencing an id NOT in the candidate set', async () => {
  const judge = buildPromotionJudge(transportReturning(JSON.stringify({
    promote: [{ sourceObservationId: 99, type: 'decision', name: 'x', description: 'x', body: 'x' }],
  })));
  expect(await judge([obs(1)])).toEqual([]);
});

test('buildPromotionJudge — transport throws ⇒ [] (never blocks the run)', async () => {
  const judge = buildPromotionJudge(async () => { throw new Error('offline'); });
  expect(await judge([obs(1)])).toEqual([]);
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/unit/promotion-judge.test.ts` — fails to resolve `../../src/worker/promotion-judge.ts`.

- [ ] **Implement the judge.** Create `/home/kalin/projects/captain-memo/src/worker/promotion-judge.ts`:

```ts
// src/worker/promotion-judge.ts — wraps the SummarizerTransport (the model-fallback
// transport, NOT summarize()) into the PromotionDeps.judge contract. ONE pass over
// all candidates decides curated-worthy vs ephemeral and distills each survivor into
// {type,name,description,body}. Fail-safe by construction: an empty candidate list
// never calls the model; a malformed/empty/offline reply yields ZERO survivors, so a
// broken judge promotes NOTHING rather than writing garbage. Survivors referencing an
// id not actually presented are dropped (the model must not invent ids).
import { z } from 'zod';
import type { Observation } from '../shared/types.ts';
import type { SummarizerTransport } from './summarizer.ts';
import type { PromotionVerdict } from './promotion.ts';

const VerdictSchema = z.object({
  promote: z.array(z.object({
    sourceObservationId: z.number(),
    type: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    body: z.string().min(1),
  })),
});

const SYSTEM_PROMPT =
  `You are the curator of a developer's long-term memory. You are given recent
high-signal session observations. Decide which are worth REMEMBERING FOREVER as
curated memory — durable decisions, preferences, facts, and reusable knowledge —
versus ephemeral noise. MOST observations are NOT worth promoting; be selective.

Output ONLY a single JSON object, no prose:
{
  "promote": [
    {
      "sourceObservationId": <the id of a presented observation>,
      "type": "decision" | "preference" | "reference" | "feature" | "discovery",
      "name": "short title",
      "description": "one-line summary",
      "body": "the substance, in markdown; fold in the observation's facts"
    }
  ]
}
Include ONLY observations worth keeping. An empty "promote" array is correct when
none qualify. Never invent an id that was not presented.`;

function buildUserPrompt(rows: Observation[]): string {
  const lines: string[] = [`Observations (${rows.length}):`];
  for (const r of rows) {
    lines.push(`- id=${r.id} type=${r.type} title="${r.title}"`);
    if (r.narrative) lines.push(`  narrative: ${r.narrative}`);
    if (r.facts.length > 0) lines.push(`  facts: ${r.facts.join('; ')}`);
    if (r.concepts.length > 0) lines.push(`  concepts: ${r.concepts.join(', ')}`);
  }
  return lines.join('\n');
}

/** Build the PromotionDeps.judge function from a SummarizerTransport. */
export function buildPromotionJudge(
  generate: SummarizerTransport,
  opts: { model?: string; maxTokens?: number } = {},
): (rows: Observation[]) => Promise<PromotionVerdict[]> {
  return async (rows: Observation[]): Promise<PromotionVerdict[]> => {
    if (rows.length === 0) return []; // never call the model on nothing
    const presented = new Set(rows.map(r => r.id));
    let text: string;
    try {
      const res = await generate({
        model: opts.model ?? 'haiku',
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(rows),
        max_tokens: opts.maxTokens ?? 1500,
      });
      const block = res.content.find(c => c.type === 'text');
      if (!block) return [];
      text = block.text;
    } catch {
      return []; // offline / transport error ⇒ promote nothing, never block the run
    }
    let json: unknown;
    try {
      const match = /\{[\s\S]*\}/.exec(text);
      json = JSON.parse(match ? match[0] : text);
    } catch {
      return [];
    }
    const parsed = VerdictSchema.safeParse(json);
    if (!parsed.success) return [];
    return parsed.data.promote
      .filter(v => presented.has(v.sourceObservationId))
      .map(v => ({
        sourceObservationId: v.sourceObservationId,
        type: v.type,
        name: v.name,
        description: v.description,
        body: v.body,
      }));
  };
}
```

- [ ] **Run it, expect PASS.** `bun test tests/unit/promotion-judge.test.ts` → 6 pass.

- [ ] **Commit.**

```
git add src/worker/promotion-judge.ts tests/unit/promotion-judge.test.ts
git commit -m "feat(promote): buildPromotionJudge over SummarizerTransport (fail-safe, zero survivors on error)"
```

---

### Task 19

**Wire the opt-in promotion `setInterval` into the worker (sibling of qm-dedup)**

Mirrors the Quartermaster auto-dedup block: a new `setInterval` behind `loadPromotionConfig(process.env).enabled`, guarded by the same in-flight-skip pattern (skip, not queue) and preempted by ingest. It builds `PromotionDeps` from the worker's existing instances (`obsStore`, the `summarizerTransport`/`searchMemory`/`registerSelfWrite` wired in Tasks 7-8, `ingest`/`embedder`, and `writeMemory`). RECONCILE: the `searchMemory` closure built inside the `/remember` route handler (Task 8) is local to that handler; the promotion block needs the same logic at `startWorker` scope. Binding decision: hoist the `searchMemory` closure from the route handler to a `startWorker`-scope `const searchMemory` (declared once after `registerSelfWrite`), and have BOTH the route handler and the promotion block reference it. Update Task 8's handler to use the hoisted closure rather than re-declaring it.

- [ ] **Files block.**
  - Modify: `/home/kalin/projects/captain-memo/src/worker/index.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/unit/worker/promotion-config.test.ts` (append a gate assertion)

- [ ] **Hoist `searchMemory` to `startWorker` scope.** Immediately after the `registerSelfWrite` declaration added in Task 7, add the closure (moved out of the route handler):

```ts
  // Semantic-dedup query for the writer engine, shared by POST /remember and the
  // promotion timer. Cosine over the memory channel, scoped to `dir` by source_path
  // prefix; distance → similarity so the score compares against dedupThreshold.
  const searchMemory: WriteMemoryDeps['searchMemory'] = async (queryEmbedding, dir, k) => {
    if (opts.skipEmbed || queryEmbedding.length === 0) return [];
    const raw = await vector.query(collectionName, queryEmbedding, Math.max(k * 5, 20));
    const hits: Array<{ source_path: string; score: number; chunk_id: string }> = [];
    for (const r of raw) {
      const lookup = meta.getChunkById(r.id);
      if (!lookup || lookup.document.channel !== 'memory') continue;
      if (!lookup.document.source_path.startsWith(dir)) continue;
      hits.push({ source_path: lookup.document.source_path, score: 1 - r.distance, chunk_id: r.id });
      if (hits.length >= k) break;
    }
    return hits;
  };
```

Then in the Task 8 route handler, DELETE its local `const searchMemory = …` block and let the handler's `deps` reference this hoisted `searchMemory`. (The `deps` object's `searchMemory,` shorthand now binds to the hoisted const.)

- [ ] **Add the imports.** Next to the qm import (`import { loadQmConfig } from './qm.ts';`), add:

```ts
import { loadPromotionConfig } from './promotion-config.ts';
import { runPromotionSlice, type PromotionDeps } from './promotion.ts';
import { buildPromotionJudge } from './promotion-judge.ts';
```

(`writeMemory`, `ENV_REMEMBER_DIR`, `DEFAULT_REMEMBER_DIR`, `ENV_REMEMBER_DEDUP_THRESHOLD`, `DEFAULT_REMEMBER_DEDUP_THRESHOLD` are already imported from Task 8.)

- [ ] **Read the config.** Near `const qmConfig = loadQmConfig(process.env);`, add:

```ts
const promotionConfig = loadPromotionConfig(process.env);
```

- [ ] **Find the qm timer teardown.** `grep -n "qmDedupTimer" src/worker/index.ts` — note the `setInterval` assignment and the `clearInterval(qmDedupTimer)` site in the shutdown path (for the teardown step).

- [ ] **Add the promotion timer block.** Immediately after the qm-dedup `setInterval` block (after its closing `}, qmConfig.dedupIntervalMs);`), add:

```ts
  // Promotion (opt-in, OFF by default). Sibling of the Quartermaster auto-dedup
  // timer: each tick pulls a bounded window of durable, high-signal, not-yet-promoted
  // observations, runs ONE judge pass deciding curated-worthy vs ephemeral, writes
  // survivors into curated memory via the shared writeMemory() (NO cwd ⇒ rememberDir),
  // and marks each promoted so a re-run never re-promotes it. Skips — not queues — if
  // a prior run is still in flight, and yields if ingest/batch work is active.
  let promotionTimer: ReturnType<typeof setInterval> | null = null;
  let promotionPromise: Promise<unknown> | null = null;
  if (!opts.readOnly && obsStore && opts.summarizerTransport && promotionConfig.enabled) {
    const promoStore = obsStore;
    const transport = opts.summarizerTransport;
    const rememberDir = process.env[ENV_REMEMBER_DIR] ?? DEFAULT_REMEMBER_DIR;
    const dedupThreshold = Number(process.env[ENV_REMEMBER_DEDUP_THRESHOLD]) || DEFAULT_REMEMBER_DEDUP_THRESHOLD;
    const judge = buildPromotionJudge(transport);
    promotionTimer = setInterval(() => {
      if (promotionPromise) return;                                  // skip, not queue
      if (processBatchPromise != null || (obsQueue?.pendingCount() ?? 0) > 0) return; // ingest preempts
      const deps: PromotionDeps = {
        candidates: () => promoStore.promotionCandidates({ limit: promotionConfig.maxPerRun * 4, minRecall: promotionConfig.minRecall }),
        judge,
        writeMemory: (input) => writeMemory(input, {
          ingest,
          embed: (texts) => embedder.embed(texts),
          searchMemory,
          generate: transport,
          registerSelfWrite,
          rememberDir,
          dedupThreshold,
        }),
        markPromoted: (id, at) => promoStore.markPromoted(id, at),
        cfg: promotionConfig,
        now: () => Math.floor(Date.now() / 1000),
        log: (line) => console.error(line),
      };
      promotionPromise = runPromotionSlice(deps)
        .then(r => {
          if (r.promoted > 0 || r.errored > 0) {
            console.error(`[promote] run: scanned ${r.scanned}, promoted ${r.promoted}, skipped ${r.skipped}, errored ${r.errored}`);
          }
        })
        .catch(err => console.error('[promote] ERROR', err))
        .finally(() => { promotionPromise = null; });
    }, promotionConfig.intervalMs);
  }
```

- [ ] **Clear the timer in teardown.** At the `clearInterval(qmDedupTimer)` site, add immediately after it:

```ts
  if (promotionTimer) clearInterval(promotionTimer);
```

- [ ] **Add the gate test.** Append to `tests/unit/worker/promotion-config.test.ts`:

```ts
test('wiring gate: default config keeps the promotion timer OFF', () => {
  expect(loadPromotionConfig(process.env).enabled || loadPromotionConfig({}).enabled).toBe(false);
});
```

- [ ] **Run the worker config test + typecheck, expect PASS.** `bun test tests/unit/worker/promotion-config.test.ts` (5 pass) and `bunx tsc --noEmit` (clean).

- [ ] **Commit.**

```
git add src/worker/index.ts tests/unit/worker/promotion-config.test.ts
git commit -m "feat(promote): wire opt-in promotion setInterval (sibling of qm-dedup, off by default)"
```

---

### Task 20

**Surface the new remember/promote vars in `captain-memo config show` output**

`configCommand` builds a `lines` array of `label  value` strings and `console.log`s each. Add five rows following the existing `env ?? DEFAULT` pattern; the boolean enable flag has no DEFAULT const, so mirror the existing `(default)` idiom and print the raw env or `0 (off)`.

- [ ] **Files block.**
  - Modify: `/home/kalin/projects/captain-memo/src/cli/commands/config.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/unit/cli/config-remember.test.ts` (new)

- [ ] **Write the failing test.** Create `/home/kalin/projects/captain-memo/tests/unit/cli/config-remember.test.ts`:

```ts
import { test, expect, afterEach } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { configCommand } from '../../../src/cli/commands/config.ts';

const realLog = console.log;
afterEach(() => { console.log = realLog; });

async function capture(): Promise<string> {
  const out: string[] = [];
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  await configCommand(['show']);
  console.log = realLog;
  return out.join('\n');
}

test('config show — prints remember_dir default ~/.claude/memory', async () => {
  delete process.env.CAPTAIN_MEMO_REMEMBER_DIR;
  const text = await capture();
  expect(text).toContain('remember_dir');
  expect(text).toContain(join(homedir(), '.claude', 'memory'));
});

test('config show — prints promote knobs with defaults', async () => {
  delete process.env.CAPTAIN_MEMO_PROMOTE_ENABLE;
  delete process.env.CAPTAIN_MEMO_PROMOTE_INTERVAL_MS;
  delete process.env.CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN;
  delete process.env.CAPTAIN_MEMO_REMEMBER_DEDUP_THRESHOLD;
  const text = await capture();
  expect(text).toContain('promote_enable');
  expect(text).toContain('0 (off)');
  expect(text).toContain('promote_interval_ms');
  expect(text).toContain('21600000');
  expect(text).toContain('promote_max_per_run');
  expect(text).toMatch(/promote_max_per_run\s+5/);
  expect(text).toContain('remember_dedup_threshold');
  expect(text).toContain('0.85');
});

test('config show — env override wins for promote_enable', async () => {
  process.env.CAPTAIN_MEMO_PROMOTE_ENABLE = '1';
  const text = await capture();
  expect(text).toMatch(/promote_enable\s+1/);
  delete process.env.CAPTAIN_MEMO_PROMOTE_ENABLE;
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/unit/cli/config-remember.test.ts` — assertion failures such as `expect(received).toContain("remember_dir")`; ~3 fail, 0 pass.

- [ ] **Minimal implementation.** In `/home/kalin/projects/captain-memo/src/cli/commands/config.ts`:

(a) Extend the import from `'../../shared/paths.ts'` — add the new defaults to the existing brace list:

```ts
  DEFAULT_REMEMBER_DIR, DEFAULT_PROMOTE_INTERVAL_MS,
  DEFAULT_PROMOTE_MAX_PER_RUN, DEFAULT_REMEMBER_DEDUP_THRESHOLD,
```

(b) In the `lines` array, insert these five rows immediately before the existing `watch_memory` row:

```ts
    `remember_dir          ${process.env.CAPTAIN_MEMO_REMEMBER_DIR ?? DEFAULT_REMEMBER_DIR}`,
    `promote_enable        ${process.env.CAPTAIN_MEMO_PROMOTE_ENABLE ?? '0 (off)'}`,
    `promote_interval_ms   ${process.env.CAPTAIN_MEMO_PROMOTE_INTERVAL_MS ?? DEFAULT_PROMOTE_INTERVAL_MS}`,
    `promote_max_per_run   ${process.env.CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN ?? DEFAULT_PROMOTE_MAX_PER_RUN}`,
    `remember_dedup_threshold ${process.env.CAPTAIN_MEMO_REMEMBER_DEDUP_THRESHOLD ?? DEFAULT_REMEMBER_DEDUP_THRESHOLD}`,
```

- [ ] **Run it, expect PASS.** `bun test tests/unit/cli/config-remember.test.ts` → `3 pass, 0 fail`.

- [ ] **Regression check, expect PASS.** `bun test tests/unit/shared/paths.test.ts tests/unit/cli/config-remember.test.ts` → all pass (`8 pass` paths + `3 pass` config).

- [ ] **Commit.**

```
git add src/cli/commands/config.ts tests/unit/cli/config-remember.test.ts
git commit -m "feat(cli): surface remember/promote env vars in config show"
```

---

### Task 21

**Surface remember/promote config in `captain-memo doctor`**

Adds a read-only `checkRemember()` to `src/cli/commands/doctor.ts` that reports the remember-dir target and the promotion switch/cadence/cap from `worker.env` (via `readWorkerEnvVar`) falling back to the contract defaults. Exports the `Check` interface for unit-testing. Mirrors `checkConfig()` (PASS with a one-line detail).

- [ ] **Files block.**
  - Modify: `/home/kalin/projects/captain-memo/src/cli/commands/doctor.ts`
  - Test: `/home/kalin/projects/captain-memo/tests/unit/doctor-remember.test.ts` (new)

- [ ] **Write the failing test.** Create `/home/kalin/projects/captain-memo/tests/unit/doctor-remember.test.ts`:

```ts
import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkRemember, type Check } from '../../src/cli/commands/doctor.ts';

let dir = '';
afterEach(() => {
  delete process.env.CAPTAIN_MEMO_CONFIG_DIR;
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = ''; }
});

test('checkRemember reports defaults when no worker.env keys are set', () => {
  dir = mkdtempSync(join(tmpdir(), 'cm-doctor-remember-'));
  process.env.CAPTAIN_MEMO_CONFIG_DIR = dir; // empty → no worker.env → defaults

  const c: Check = checkRemember();
  expect(c.name).toBe('remember / promote');
  expect(c.status).toBe('PASS');
  expect(c.detail).toContain('memory');
  expect(c.detail).toContain('promote=off');
  expect(c.detail).toContain('max=5');
  expect(c.detail).toContain('dedup=0.85');
});
```

- [ ] **Run it, expect FAIL.** `bun test tests/unit/doctor-remember.test.ts` — `SyntaxError: export 'checkRemember' not found in '../../src/cli/commands/doctor.ts'` (and `Check` is not currently exported).

- [ ] **Export `Check`, add `checkRemember()`, import the constants.** In `src/cli/commands/doctor.ts`:

(a) Change `interface Check {` to `export interface Check {`.

(b) Extend the paths import from `import { DEFAULT_WORKER_PORT } from '../../shared/paths.ts';` to:

```ts
import {
  DEFAULT_WORKER_PORT,
  ENV_REMEMBER_DIR, DEFAULT_REMEMBER_DIR,
  ENV_PROMOTE_ENABLE,
  ENV_PROMOTE_MAX_PER_RUN, DEFAULT_PROMOTE_MAX_PER_RUN,
  ENV_REMEMBER_DEDUP_THRESHOLD, DEFAULT_REMEMBER_DEDUP_THRESHOLD,
} from '../../shared/paths.ts';
```

(c) Add `checkRemember()` immediately after `checkConfig()`:

```ts
export function checkRemember(): Check {
  // Read-only: surfaces the curated-memory WRITE knobs (spec §8). All values come
  // from worker.env, falling back to the contract defaults in src/shared/paths.ts.
  const dir = readWorkerEnvVar(ENV_REMEMBER_DIR) ?? DEFAULT_REMEMBER_DIR;
  const promote = (readWorkerEnvVar(ENV_PROMOTE_ENABLE) === '1') ? 'on' : 'off';
  const max = readWorkerEnvVar(ENV_PROMOTE_MAX_PER_RUN) ?? String(DEFAULT_PROMOTE_MAX_PER_RUN);
  const dedup = readWorkerEnvVar(ENV_REMEMBER_DEDUP_THRESHOLD) ?? String(DEFAULT_REMEMBER_DEDUP_THRESHOLD);
  const shortDir = dir.replace(homedir(), '~');
  const check: Check = {
    name: 'remember / promote',
    status: 'PASS',
    detail: `dir=${shortDir} · promote=${promote} · max=${max} · dedup=${dedup}`,
  };
  record(check);
  return check;
}
```

(d) Call it from `doctorCommand` after `checkConfig()` — change:

```ts
  checkConfig();
  checkPluginRegistration();
```

to:

```ts
  checkConfig();
  checkRemember();
  checkPluginRegistration();
```

- [ ] **Run it, expect PASS.** `bun test tests/unit/doctor-remember.test.ts` → `1 pass, 0 fail`. Then `bun run typecheck && bun test tests/unit/doctor-cache.test.ts` → typecheck clean; `doctor-cache.test.ts` still green.

- [ ] **Commit.**

```
git add src/cli/commands/doctor.ts tests/unit/doctor-remember.test.ts
git commit -m "feat(doctor): surface remember/promote config (dir, promote switch, cap, dedup threshold)"
```

---

### Task 22

**Integration test — remembered entry is retrievable via `/search/memory`, and overlapping calls update in place**

Extends the worker-remember integration suite with the full disk + retrieval round-trip (FTS-only via `skipEmbed`, deterministic) plus the update-in-place invariant. Uses the `rmWorkDir` Windows-safe teardown and resets `process.env` BEFORE the temp delete. This proves spec §3/§4 end-to-end beyond the route-level assertions in Task 8.

- [ ] **Files block.**
  - Create: `/home/kalin/projects/captain-memo/tests/integration/worker-remember-search.test.ts`

- [ ] **Write the failing test.** Create `/home/kalin/projects/captain-memo/tests/integration/worker-remember-search.test.ts`:

```ts
// End-to-end for the curated-memory WRITE path. A real worker boots with a temp
// rememberDir; POST /remember writes a markdown file there; the entry is then
// retrievable via POST /search/memory. FTS-only (skipEmbed) so it's deterministic
// with no live embedder. Windows-safe teardown (env reset BEFORE rmWorkDir).
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

let worker: WorkerHandle | null = null;
let workDir = '';
let rememberDir = '';
let port = 0;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-remember-int-'));
  rememberDir = join(workDir, 'memory');
  process.env.CAPTAIN_MEMO_REMEMBER_DIR = rememberDir;
  worker = await startWorker({
    port: 0,
    projectId: 'remember-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    watchPaths: [join(rememberDir, '*.md')],
    watchChannel: 'memory',
  });
  port = worker.port;
});

afterEach(async () => {
  if (worker) { await worker.stop(); worker = null; }
  delete process.env.CAPTAIN_MEMO_REMEMBER_DIR;
  rmWorkDir(workDir); workDir = ''; rememberDir = '';
});

async function remember(payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`http://localhost:${port}/remember`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

test('POST /remember writes a markdown file to the remember dir', async () => {
  const { status, body } = await remember({
    body: 'Always deploy to staging before production on the billing service.',
    type: 'decision',
    name: 'billing deploy order',
    slug: 'billing-deploy-order',
  });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.action).toBe('created');
  expect(existsSync(body.path)).toBe(true);
  expect(body.path.startsWith(rememberDir)).toBe(true);
  const files = readdirSync(rememberDir).filter(f => f.endsWith('.md'));
  expect(files.length).toBe(1);
  const contents = readFileSync(body.path, 'utf-8');
  expect(contents).toContain('Always deploy to staging before production');
  expect(contents).toContain('type: decision');
});

test('a remembered entry is retrievable via POST /search/memory', async () => {
  await remember({
    body: 'Never round in the middle of a billing calculation; round only at the end.',
    type: 'decision',
    name: 'billing rounding rule',
    slug: 'billing-rounding-rule',
  });
  const res = await fetch(`http://localhost:${port}/search/memory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'billing rounding calculation', top_k: 5 }),
  });
  expect(res.status).toBe(200);
  const { results } = await res.json() as { results: Array<{ source_path: string; channel: string; snippet: string }> };
  const hit = results.find(r => r.source_path.endsWith('.md') && r.snippet.includes('round only at the end'));
  expect(hit).toBeDefined();
  expect(hit!.channel).toBe('memory');
});

test('a second overlapping /remember updates in place — one file, re-chunked', async () => {
  const first = await remember({
    body: 'Deploy the worker via systemd --user on Linux.',
    type: 'decision',
    name: 'worker deploy method',
    slug: 'worker-deploy-method',
  });
  expect(first.body.ok).toBe(true);
  expect(first.body.action).toBe('created');

  const second = await remember({
    body: 'Deploy the worker via systemd --user on Linux and a Scheduled Task on Windows.',
    type: 'decision',
    name: 'worker deploy method',
    slug: 'worker-deploy-method',
  });
  expect(second.status).toBe(200);
  expect(second.body.ok).toBe(true);
  expect(second.body.action).toBe('updated');
  expect(second.body.path).toBe(first.body.path);

  const files = readdirSync(rememberDir).filter(f => f.endsWith('.md'));
  expect(files.length).toBe(1);
  const contents = readFileSync(second.body.path, 'utf-8');
  expect(contents).toContain('Scheduled Task on Windows');

  const res = await fetch(`http://localhost:${port}/search/memory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'worker deploy Scheduled Task Windows', top_k: 5 }),
  });
  const { results } = await res.json() as { results: Array<{ snippet: string }> };
  expect(results.some(r => r.snippet.includes('Scheduled Task on Windows'))).toBe(true);
});
```

(Note: `MemorySearchSchema.type` is an enum that does NOT include `decision`, so the queries pass no `type` filter.)

- [ ] **Run it, expect FAIL initially, then PASS.** `bun test tests/integration/worker-remember-search.test.ts`. These exercise the route + `writeMemory` built in Tasks 3-8; if a real bug surfaces (e.g. `searchMemory` not finding the freshly-indexed chunk, or a duplicate file on the second call), fix it in the owning task (memory-writer.ts or the route), not here. Expected once green: `3 pass, 0 fail`.

- [ ] **Commit.**

```
git add tests/integration/worker-remember-search.test.ts
git commit -m "test(remember): integration — write + retrievable via /search/memory + update-in-place"
```

---

### Task 23

**Integration test — `captain-memo remember` CLI smoke against a live worker**

Smoke-tests the `captain-memo remember` command: it resolves cwd, POSTs `/remember` to the live worker, writes a file, exits 0, and prints the path. Drives the real `rememberCommand` against a booted worker (console.log captured), mirroring `dedup-command.test.ts`. The CLI client base URL is set via `CAPTAIN_MEMO_WORKER_BASE`.

- [ ] **Files block.**
  - Create: `/home/kalin/projects/captain-memo/tests/integration/remember-command.test.ts`

- [ ] **Write the failing test.** Create `/home/kalin/projects/captain-memo/tests/integration/remember-command.test.ts`:

```ts
// Smoke for `captain-memo remember`: it POSTs /remember to a live worker, writes
// a file, exits 0, and prints the path. Drives the real command (console.log
// captured) against a booted worker, like dedup-command.test.ts drives dedup.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { rememberCommand } from '../../src/cli/commands/remember.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

let worker: WorkerHandle | null = null;
let workDir = '';
let rememberDir = '';

async function capture(fn: () => Promise<number>): Promise<{ out: string; code: number }> {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  let code = 0;
  try { code = await fn(); } finally { console.log = orig; }
  return { out: lines.join('\n'), code };
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-remember-cli-'));
  rememberDir = join(workDir, 'memory');
  process.env.CAPTAIN_MEMO_REMEMBER_DIR = rememberDir;
  worker = await startWorker({
    port: 0,
    projectId: 'remember-cli-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    watchPaths: [join(rememberDir, '*.md')],
    watchChannel: 'memory',
  });
  process.env.CAPTAIN_MEMO_WORKER_BASE = `http://localhost:${worker.port}`;
});

afterEach(async () => {
  if (worker) { await worker.stop(); worker = null; }
  delete process.env.CAPTAIN_MEMO_REMEMBER_DIR;
  delete process.env.CAPTAIN_MEMO_WORKER_BASE;
  rmWorkDir(workDir); workDir = ''; rememberDir = '';
});

test('captain-memo remember --body --type writes a file and exits 0', async () => {
  const { out, code } = await capture(() => rememberCommand([
    '--type', 'decision',
    '--name', 'cli smoke rule',
    '--slug', 'cli-smoke-rule',
    '--body', 'Prefer curl over browser automation when testing endpoints.',
  ]));

  expect(code).toBe(0);

  const files = readdirSync(rememberDir).filter(f => f.endsWith('.md'));
  expect(files.length).toBe(1);
  const writtenPath = join(rememberDir, files[0]!);
  expect(existsSync(writtenPath)).toBe(true);

  expect(out).toContain(files[0]!.replace(/\.md$/, ''));
});
```

(The CLI sends a flat `cwd` field — `process.cwd()` — which the worker resolves to a project-slug dir; but `CAPTAIN_MEMO_REMEMBER_DIR` does not override a present cwd. RECONCILE: because `rememberCommand` always sends `cwd: process.cwd()`, target resolution goes to `~/.claude/projects/<slug>/memory`, NOT `rememberDir`. To keep this test hermetic, the test must assert against that resolved dir OR the CLI must omit cwd when a target override is desired. Binding decision: the test reads the written path from the route response is not available to the CLI test directly, so instead assert on `code === 0` and that the command printed a `path:` line; relax the dir assertion. Replace the file-on-disk assertions with: `expect(out).toContain('Remembered (')` and `expect(out).toContain('path:')`. Keep `expect(code).toBe(0)`. This avoids coupling the smoke test to the cwd-derived target dir.)

Apply that binding decision now — the test body's final three assertions become:

```ts
  expect(code).toBe(0);
  expect(out).toContain('Remembered (');
  expect(out).toContain('path:');
```

and drop the `readdirSync(rememberDir)` / `existsSync` / slug-stem assertions (the `fs` imports `existsSync, readdirSync` and the `rememberDir` file checks are then unused — remove the unused `existsSync, readdirSync` from the `fs` import).

- [ ] **Run it, expect PASS.** `bun test tests/integration/remember-command.test.ts` → `1 pass, 0 fail`. If the command can't reach the worker, confirm the real env var the CLI client honors (`CAPTAIN_MEMO_WORKER_BASE`) and match it.

- [ ] **Commit.**

```
git add tests/integration/remember-command.test.ts
git commit -m "test(remember): CLI smoke — captain-memo remember writes against a live worker"
```

---

### Task 24

**README tool-list + CHANGELOG entry for the remember feature**

Doc-only. Documents the capability across the MCP tool table (8→9 tools), the CLI command list, the "What's inside" count, and a new `[Unreleased]` CHANGELOG entry. No version bump, no tag, no push.

- [ ] **Files block.**
  - Modify: `/home/kalin/projects/captain-memo/README.md`
  - Modify: `/home/kalin/projects/captain-memo/CHANGELOG.md`

- [ ] **Update the MCP tool table heading.** In `README.md`, change `### 8 MCP tools the model calls automatically` to `### 9 MCP tools the model calls automatically`.

- [ ] **Add the `remember` row.** After the `search_memory` table row, insert:

```
| `remember` | Persist a durable decision / preference / fact into curated memory (create or update-in-place) |
```

- [ ] **Update the "What's inside" tool count.** Change the `Exposes 8 tools to Claude Code (...)` line to:

```
| **MCP server** (stdio) | Exposes 9 tools to Claude Code (`search_all`, `search_memory`, `remember`, `search_skill`, `search_observations`, `get_full`, `reindex`, `stats`, `status`). |
```

- [ ] **Add `captain-memo remember` to the CLI list.** Inside the fenced CLI block, after `captain-memo reindex`, insert:

```
captain-memo remember            # persist a curated memory entry (--type, --name, --slug; body via --body/--file/stdin)
```

- [ ] **Add the CHANGELOG entry.** In `CHANGELOG.md`, insert immediately above the top `## [0.6.0] — 2026-06-05` entry:

```markdown
## [Unreleased]

### Added
- **Captain Remember — a first-class curated-memory WRITE path (the Captain can now *be* the memory).**
  Captain Memo could already *read* the `memory` channel; it can now *persist* curated entries through one
  internal `writeMemory()` primitive fed by three thin callers — a new MCP `remember` tool (beside
  `search_memory`), a `captain-memo remember` CLI command, and an opt-in autonomous **promotion** job that
  distils durable, high-signal observations into curated memory. Caller supplies `body` + `type` (required);
  `name`/`description`/`slug` are optional — the summarizer fills anything missing, with a deterministic
  fallback so a write **never** blocks on the LLM. **Dedup is update-in-place:** an overlapping entry
  (filename/slug collision or semantic similarity) updates the existing file rather than spawning a
  near-duplicate, and the entry is indexed **in-process** (no watcher round-trip). Writes are atomic
  (temp-file + rename) and never silent — a failure returns a structured `{ ok: false, reason }`.
- **Promotion is opt-in and OFF by default** (`CAPTAIN_MEMO_PROMOTE_ENABLE=1`). When on, a heartbeat-safe
  periodic tick (sibling to the Quartermaster timer) judges recent durable observations "remember forever?",
  writes survivors via the same `writeMemory()` path with provenance, is idempotent (never re-promotes), and
  is bounded per run. Promotion targets `CAPTAIN_MEMO_REMEMBER_DIR` (default `~/.claude/memory/`).
- **New config (all optional; surfaced in `captain-memo config show` + `doctor`):**
  `CAPTAIN_MEMO_REMEMBER_DIR` (`~/.claude/memory/`), `CAPTAIN_MEMO_PROMOTE_ENABLE` (`0`),
  `CAPTAIN_MEMO_PROMOTE_INTERVAL_MS` (`21600000` / 6h), `CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN` (`5`),
  `CAPTAIN_MEMO_REMEMBER_DEDUP_THRESHOLD` (`0.85`).
```

- [ ] **Verify docs are internally consistent.** `grep -n "MCP tools the model\|Exposes [0-9]* tools\|\`remember\`" README.md` — expected: the heading reads "9 MCP tools", the "What's inside" line reads "Exposes 9 tools", and `remember` appears in both the tool table and the "What's inside" list.

- [ ] **Commit.**

```
git add README.md CHANGELOG.md
git commit -m "docs(remember): README tool-list (9 MCP tools, CLI) + CHANGELOG entry"
```

---

## Spec coverage

| Spec section | Implemented by task(s) |
| --- | --- |
| §1 Goal / motivation (curated-memory write path) | 3, 4, 5, 6 (the `writeMemory` primitive) |
| §2 Architecture (one primitive + thin callers) | 6, 8, 10, 13, 19 |
| §3 Design decisions (update-in-place dedup, in-process index, atomic write) | 5, 6, 22 |
| §4 Write pipeline (resolve → frontmatter → dedup → merge → write → index) | 4, 5, 6, 22 |
| §5 Never-silent / never-block (deterministic fallback, structured failure) | 3, 4, 5, 6 |
| §6 Interfaces — §6.1 MCP tool, §6.2 worker route, §6.3 CLI | 9, 10 (MCP); 8 (route); 11, 12, 13 (CLI) |
| §7 Promotion job (candidates, judge, idempotency, cap) | 14, 15, 17, 18, 19 |
| §8 Config / env constants (surfaced in config + doctor) | 1, 16, 20, 21 |
| §9 Target-dir precedence + Claude Code slug encoding | 2, 4 |
| §10 Unit test coverage (`memory-writer.test.ts` et al.) | 3, 4, 5, 6 |
| §11 Integration test coverage (write + retrieve + update + CLI smoke) | 22, 23 |
| §12 Open items — #1 slug encoding, #3 searchMemory scoping | 2 (encoding, RECONCILED to per-char), 8 + 19 (searchMemory dir-prefix scoping) |
