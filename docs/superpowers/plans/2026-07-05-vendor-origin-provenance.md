# Vendor Origin Provenance (`origin_agent`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tag every captured `Observation` with which AI coding tool produced it (`origin_agent`), so search/`get_full` results and the stored corpus always carry a concrete provenance tag instead of an unlabeled blob.

**Architecture:** A new zero-dependency module `src/shared/origin-agent.ts` exposes a closed 9-member enum and an env-signal detector (`detectOriginAgent`, never throws). It's wired through the one active write path for `Observation` rows: the Claude-Code hook pipeline (`post-tool-use.ts`/`pre-compact.ts` → `/observation/enqueue` → `ObservationsStore` → `chunkObservation`). Additive SQLite migration `v13` adds a nullable `origin_agent` column; old/unsigned rows read back `null` and are rendered `'unknown'` at the chunk-metadata surface, so a consumer never sees a missing field.

**Tech Stack:** Bun, TypeScript (`strict`, `exactOptionalPropertyTypes`), `bun:sqlite`, Zod, `bun:test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-05-vendor-origin-provenance-design.md` — read it if anything below is unclear.
- Reuse `src/shared/origin-agent.ts`'s logic near-verbatim from the reference implementation (commit `e4de845` on the stale `grandplan/track-ac` branch) — do not redesign the detection algorithm.
- `ORIGIN_AGENTS` has 9 members: `claude-code, codex, cursor, gemini, opencode, vibe, vscode, jetbrains, unknown`. Do **not** invent env-var heuristics for the 7 non-Claude-Code vendors — none has a real hook path today; they're reachable only via the explicit `AI_AGENT` override.
- Migration version is **`13`**, not the reference's `11` (both `v11`/`v12` are already claimed on this branch by unrelated features).
- Out of scope: the curated `memory` channel / `remember` MCP tool / `memory-writer.ts` — do not touch them.
- Target branch for this plan: `captain-memo` (OSS master), directory `/home/kalin/projects/captain-memo`. A follow-up task at the end mirrors the identical patch to `captain-memo-fed` (federation).
- Run `bun run typecheck` and the full test suite (`bun test`) after each task that touches shared types — don't wait until the end to discover a break.

---

### Task 1: `origin-agent.ts` detector module

**Files:**
- Create: `src/shared/origin-agent.ts`
- Test: `tests/unit/origin-agent.test.ts`

**Interfaces:**
- Produces: `ORIGIN_AGENTS: readonly string[]` (9 members), `type OriginAgent`, `UNKNOWN_ORIGIN_AGENT: OriginAgent`, `asOriginAgent(v: unknown): OriginAgent | null`, `detectOriginAgent(env?: Record<string, string | undefined>): OriginAgent`. Every later task imports from `'../shared/origin-agent.ts'` (relative depth varies by importer).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/origin-agent.test.ts`:

```typescript
import { test, expect } from 'bun:test';
import { detectOriginAgent, asOriginAgent, ORIGIN_AGENTS, type OriginAgent } from '../../src/shared/origin-agent.ts';

test('detectOriginAgent — CLAUDECODE=1 → claude-code', () => {
  expect(detectOriginAgent({ CLAUDECODE: '1' })).toBe('claude-code');
});

test('detectOriginAgent — CLAUDE_CODE_ENTRYPOINT set → claude-code', () => {
  expect(detectOriginAgent({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('claude-code');
});

test('detectOriginAgent — empty env bag → unknown', () => {
  expect(detectOriginAgent({})).toBe('unknown');
});

test('detectOriginAgent — explicit AI_AGENT wins for each known vendor', () => {
  expect(detectOriginAgent({ AI_AGENT: 'codex' })).toBe('codex');
  expect(detectOriginAgent({ AI_AGENT: 'cursor' })).toBe('cursor');
  expect(detectOriginAgent({ AI_AGENT: 'gemini' })).toBe('gemini');
  expect(detectOriginAgent({ AI_AGENT: 'claude-code' })).toBe('claude-code');
  expect(detectOriginAgent({ AI_AGENT: 'opencode' })).toBe('opencode');
  expect(detectOriginAgent({ AI_AGENT: 'vibe' })).toBe('vibe');
  expect(detectOriginAgent({ AI_AGENT: 'vscode' })).toBe('vscode');
  expect(detectOriginAgent({ AI_AGENT: 'jetbrains' })).toBe('jetbrains');
});

test('detectOriginAgent — AI_AGENT is normalized (case / surrounding whitespace)', () => {
  expect(detectOriginAgent({ AI_AGENT: '  Codex ' })).toBe('codex');
  expect(detectOriginAgent({ AI_AGENT: 'GEMINI' })).toBe('gemini');
});

test('detectOriginAgent — unrecognized AI_AGENT falls through to other signals', () => {
  expect(detectOriginAgent({ AI_AGENT: 'totally-made-up', CLAUDECODE: '1' })).toBe('claude-code');
  expect(detectOriginAgent({ AI_AGENT: 'totally-made-up' })).toBe('unknown');
});

test('detectOriginAgent — AI_AGENT takes precedence over CLAUDECODE when both are known', () => {
  expect(detectOriginAgent({ AI_AGENT: 'codex', CLAUDECODE: '1' })).toBe('codex');
});

test('detectOriginAgent — CLAUDECODE present but empty-string is not treated as claude-code', () => {
  expect(detectOriginAgent({ CLAUDECODE: '' })).toBe('unknown');
});

test('detectOriginAgent — always returns a member of the closed ORIGIN_AGENTS set', () => {
  const cases: Array<Record<string, string | undefined> | undefined> = [
    undefined, {}, { AI_AGENT: '' }, { CLAUDECODE: '' }, { AI_AGENT: 'xyz' },
    { CLAUDECODE: '1' }, { AI_AGENT: 'gemini' },
  ];
  for (const env of cases) {
    const got: OriginAgent = detectOriginAgent(env);
    expect(ORIGIN_AGENTS).toContain(got);
  }
});

test('asOriginAgent — narrows a valid string, rejects invalid/non-string values', () => {
  expect(asOriginAgent('codex')).toBe('codex');
  expect(asOriginAgent('unknown')).toBe('unknown');
  expect(asOriginAgent('not-a-vendor')).toBeNull();
  expect(asOriginAgent(null)).toBeNull();
  expect(asOriginAgent(undefined)).toBeNull();
  expect(asOriginAgent(42)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/origin-agent.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/origin-agent.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/shared/origin-agent.ts`:

```typescript
/**
 * Vendor provenance: which AI agent authored a captured memory/observation.
 *
 * Mirrors the federation `origin_peer` tag (which captain a memory came from)
 * but at the agent layer (which CLI/tool produced it). Stored alongside `branch`
 * on each observation and surfaced in search / get_full result metadata so a
 * consumer can see who wrote a memory.
 *
 * Closed set — `unknown` is the safe default for old rows and for any env we
 * can't classify. Additive + backward-compatible: a row with no recorded agent
 * reads back as null at the store layer and is rendered as 'unknown' to callers.
 */
export const ORIGIN_AGENTS = [
  'claude-code', 'codex', 'cursor', 'gemini', 'opencode', 'vibe', 'vscode', 'jetbrains', 'unknown',
] as const;

export type OriginAgent = (typeof ORIGIN_AGENTS)[number];

/** Default when no signal identifies the agent. */
export const UNKNOWN_ORIGIN_AGENT: OriginAgent = 'unknown';

/** Narrow an unknown value to an OriginAgent, or null when it isn't one. */
export function asOriginAgent(v: unknown): OriginAgent | null {
  return typeof v === 'string' && (ORIGIN_AGENTS as readonly string[]).includes(v)
    ? (v as OriginAgent)
    : null;
}

/**
 * Detect the originating AI agent from environment signals. Best-effort and
 * NEVER throws (mirrors detectBranchSync): an absent or unrecognizable env
 * always resolves to a valid OriginAgent, defaulting to 'unknown'.
 *
 * Precedence:
 *  1. An explicit, RECOGNIZED `AI_AGENT` value (case/space-insensitive) — the
 *     authoritative override a vendor or wrapper can set deliberately.
 *  2. `CLAUDECODE` set to a non-empty value → 'claude-code' (Claude Code exports
 *     CLAUDECODE=1 into the hook/tool environment).
 *  3. `CLAUDE_CODE_ENTRYPOINT` set to a non-empty value → 'claude-code'.
 *  4. Otherwise → 'unknown'.
 *
 * The other 7 vendors (codex/cursor/gemini/opencode/vibe/vscode/jetbrains) have
 * no verified env-var signal today — none has a hook path that calls this
 * function yet — so they're reachable only via the explicit AI_AGENT override.
 *
 * `env` is injected (defaults to process.env) purely so callers/tests stay
 * hermetic; production hooks call detectOriginAgent() with no args.
 */
export function detectOriginAgent(
  env: Record<string, string | undefined> | undefined = process.env,
): OriginAgent {
  const e = env ?? {};

  const explicit = asOriginAgent((e.AI_AGENT ?? '').trim().toLowerCase());
  if (explicit) return explicit;

  if ((e.CLAUDECODE ?? '').length > 0) return 'claude-code';
  if ((e.CLAUDE_CODE_ENTRYPOINT ?? '').length > 0) return 'claude-code';

  return UNKNOWN_ORIGIN_AGENT;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/origin-agent.test.ts`
Expected: PASS — 10 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/shared/origin-agent.ts tests/unit/origin-agent.test.ts
git commit -m "feat(provenance): add origin-agent detector module (C1 foundation)"
```

---

### Task 2: Extend `Observation`/`RawObservationEvent` types + fix resulting fixtures

**Files:**
- Modify: `src/shared/types.ts:69-83` (`RawObservationEvent`), `src/shared/types.ts:90-105` (`Observation`)
- Modify (mechanical, one line each): `tests/integration/worker-worknote-enrichment.test.ts:25`, `tests/unit/promotion-judge.test.ts:11`, `tests/unit/chunkers/observation.test.ts:19`, `tests/integration/worker-efficiency.test.ts:79`, `tests/integration/dedup-command.test.ts:23`, `tests/unit/promotion.test.ts:14`, `tests/unit/supersede-command.test.ts:20`, `tests/unit/observations-store.test.ts:13` (the `tideBase` fixture), `src/migration/transform.ts:94`

**Interfaces:**
- Consumes: `OriginAgent` from `./origin-agent.ts` (Task 1).
- Produces: `RawObservationEvent.origin_agent?: OriginAgent` (optional), `Observation.origin_agent: OriginAgent | null` (required, nullable). Every later task's code references these exact field names/types.

- [ ] **Step 1: Add the fields to `shared/types.ts`**

In `src/shared/types.ts`, add the import at the top of the file (near the other type imports) and the two fields:

```typescript
import type { OriginAgent } from './origin-agent.ts';
```

In `RawObservationEvent` (after the `branch?: string | null;` line):

```typescript
  /** Origin of the observation: "post-tool-use" (default), "pre-compact", etc. */
  source?: string;
  /** Originating AI agent (claude-code | codex | cursor | gemini | opencode |
   *  vibe | vscode | jetbrains | unknown), detected at capture time from env
   *  signals. Optional + best-effort: absent on pre-C1 hooks. */
  origin_agent?: OriginAgent;
```

(This replaces the existing `source?: string;` line with itself plus the new field directly after it — the file's line order becomes `branch?`, `source?`, `origin_agent?`.)

In `Observation` (after the `branch: string | null;` line):

```typescript
  /** Git branch active when the observation was captured, or null. */
  branch: string | null;
  /** Originating AI agent that authored this observation, or null for rows
   *  captured before C1 (vendor provenance) or by a hook that sent no signal.
   *  Surfaced as 'unknown' in result metadata when null. Mirrors federation's
   *  origin_peer, but at the agent layer. */
  origin_agent: OriginAgent | null;
```

- [ ] **Step 2: Run typecheck to enumerate every break**

Run: `bun run typecheck 2>&1 | grep -i "origin_agent\|Property 'origin_agent' is missing"`
Expected: a list of `error TS2741: Property 'origin_agent' is missing in type '...'` errors, one per fixture file listed above.

- [ ] **Step 3: Fix each fixture — add `origin_agent: null,` next to `branch: null,`**

For each of these 9 sites, add `origin_agent: null,` immediately after the existing `branch: null,` (or `branch: null` when it's the last field on its line before a comma-separated neighbor — match the file's own line style):

`tests/integration/worker-worknote-enrichment.test.ts:25` — change:
```typescript
    created_at_epoch: 1_700_000_000, branch: null, work_tokens: null,
```
to:
```typescript
    created_at_epoch: 1_700_000_000, branch: null, origin_agent: null, work_tokens: null,
```

`tests/unit/promotion-judge.test.ts:11` — change:
```typescript
    created_at_epoch: 1_700_000_000, branch: null, work_tokens: null, stored_tokens: null,
```
to:
```typescript
    created_at_epoch: 1_700_000_000, branch: null, origin_agent: null, work_tokens: null, stored_tokens: null,
```

`tests/unit/chunkers/observation.test.ts:19` — change:
```typescript
  branch: null,
  work_tokens: null,
```
to:
```typescript
  branch: null,
  origin_agent: null,
  work_tokens: null,
```

`tests/integration/worker-efficiency.test.ts:79` — change:
```typescript
      branch: null, work_tokens: 5000,
```
to:
```typescript
      branch: null, origin_agent: null, work_tokens: 5000,
```

`tests/integration/dedup-command.test.ts:23` — change:
```typescript
    files_read: [], files_modified: [], created_at_epoch: 100, branch: null, work_tokens: null,
```
to:
```typescript
    files_read: [], files_modified: [], created_at_epoch: 100, branch: null, origin_agent: null, work_tokens: null,
```

`tests/unit/promotion.test.ts:14` — change:
```typescript
    created_at_epoch: 1_700_000_000, branch: null, work_tokens: null, stored_tokens: null,
```
to:
```typescript
    created_at_epoch: 1_700_000_000, branch: null, origin_agent: null, work_tokens: null, stored_tokens: null,
```

`tests/unit/supersede-command.test.ts:20` — change:
```typescript
  created_at_epoch: 1_700_000_000, branch: null, work_tokens: null,
```
to:
```typescript
  created_at_epoch: 1_700_000_000, branch: null, origin_agent: null, work_tokens: null,
```

`tests/unit/observations-store.test.ts:13` (the `tideBase` fixture) — change:
```typescript
  created_at_epoch: 1_700_000_000, branch: null, work_tokens: null,
```
to:
```typescript
  created_at_epoch: 1_700_000_000, branch: null, origin_agent: null, work_tokens: null,
```

`src/migration/transform.ts:94` — change:
```typescript
    branch: null,
    work_tokens: row.discovery_tokens ? Number(row.discovery_tokens) : null,
```
to:
```typescript
    branch: null,
    // Migrated claude-mem rows predate vendor provenance → no agent recorded.
    origin_agent: null,
    work_tokens: row.discovery_tokens ? Number(row.discovery_tokens) : null,
```

- [ ] **Step 4: Re-run typecheck to confirm zero remaining `origin_agent` errors**

Run: `bun run typecheck 2>&1 | grep -i "origin_agent"`
Expected: no output. (If any remain, `bun run typecheck 2>&1 | grep "error TS"` to find them — they're the same one-line fix at whatever new site the compiler flags. `tests/unit/rerank.test.ts`, `tests/unit/worker/rerank.test.ts`, and `tests/integration/search-boosts.test.ts` also contain `branch: null` but belong to an unrelated `RerankChunk`/ad-hoc type, not `Observation` — do NOT edit those.)

- [ ] **Step 5: Run the full unit suite to confirm no behavior change**

Run: `bun run test:unit 2>&1 | tail -10`
Expected: all tests pass (same pass count as before this task, since every change so far is either purely additive or a like-for-like fixture field).

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts tests/integration/worker-worknote-enrichment.test.ts tests/unit/promotion-judge.test.ts tests/unit/chunkers/observation.test.ts tests/integration/worker-efficiency.test.ts tests/integration/dedup-command.test.ts tests/unit/promotion.test.ts tests/unit/supersede-command.test.ts tests/unit/observations-store.test.ts src/migration/transform.ts
git commit -m "feat(provenance): add origin_agent field to Observation/RawObservationEvent"
```

---

### Task 3: Wire the capture hooks

**Files:**
- Modify: `src/hooks/post-tool-use.ts`
- Modify: `src/hooks/pre-compact.ts`

**Interfaces:**
- Consumes: `detectOriginAgent()` from `../shared/origin-agent.ts` (Task 1).

- [ ] **Step 1: Wire `post-tool-use.ts`**

Add the import (alongside the existing `detectBranchSync` import):

```typescript
import { detectOriginAgent } from '../shared/origin-agent.ts';
```

In the `event: RawObservationEvent` object literal, add the field after `branch: detectBranchSync(process.cwd()),`:

```typescript
    branch: detectBranchSync(process.cwd()),
    origin_agent: detectOriginAgent(),
```

- [ ] **Step 2: Wire `pre-compact.ts`**

Same import addition, and in its `event` literal add the field after `branch: detectBranchSync(process.cwd()),` (immediately before the existing `source: 'pre-compact',` line):

```typescript
    branch: detectBranchSync(process.cwd()),
    origin_agent: detectOriginAgent(),
    source: 'pre-compact',
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck 2>&1 | grep -i "post-tool-use\|pre-compact"`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/post-tool-use.ts src/hooks/pre-compact.ts
git commit -m "feat(provenance): capture origin_agent at hook time"
```

---

### Task 4: Chunker surfaces `origin_agent`

**Files:**
- Modify: `src/worker/chunkers/observation.ts`
- Test: `tests/unit/chunkers/observation.test.ts`

**Interfaces:**
- Consumes: `UNKNOWN_ORIGIN_AGENT` from `../../shared/origin-agent.ts`.
- Produces: `chunkObservation()`'s returned chunk now has `metadata.origin_agent: OriginAgent`.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/chunkers/observation.test.ts`, add after the existing `'chunkObservation — metadata propagates type, files, project, observation ...'` test:

```typescript
test('chunkObservation — origin_agent vendor provenance is surfaced in chunk metadata', () => {
  const [chunk] = chunkObservation({ ...observation, origin_agent: 'codex' });
  expect(chunk!.metadata.origin_agent).toBe('codex');
});

test('chunkObservation — origin_agent null renders as unknown in metadata (back-compat)', () => {
  const [chunk] = chunkObservation({ ...observation, origin_agent: null });
  expect(chunk!.metadata.origin_agent).toBe('unknown');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/chunkers/observation.test.ts`
Expected: FAIL — `expect(received).toBe(expected)` with `received: undefined` (metadata has no `origin_agent` key yet).

- [ ] **Step 3: Implement**

In `src/worker/chunkers/observation.ts`, add the import:

```typescript
import { UNKNOWN_ORIGIN_AGENT } from '../../shared/origin-agent.ts';
```

In `chunkObservation`'s `baseMetadata` object, add after `work_tokens: obs.work_tokens ?? null,`:

```typescript
    work_tokens: obs.work_tokens ?? null,
    // Vendor provenance — null (no signal recorded) surfaces as 'unknown' so a
    // consumer always sees a concrete agent tag. Mirrors origin_peer surfacing.
    origin_agent: obs.origin_agent ?? UNKNOWN_ORIGIN_AGENT,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/chunkers/observation.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 5: Commit**

```bash
git add src/worker/chunkers/observation.ts tests/unit/chunkers/observation.test.ts
git commit -m "feat(provenance): surface origin_agent in observation chunk metadata"
```

---

### Task 5: Store migration `v13` + insert/read wiring

**Files:**
- Modify: `src/worker/observations-store.ts`
- Test: `tests/unit/observations-store.test.ts`

**Interfaces:**
- Consumes: `asOriginAgent`, `type OriginAgent` from `../shared/origin-agent.ts`.
- Produces: `NewObservation.origin_agent?: OriginAgent | null` (optional override), `ObservationsStore.insert()` accepts and persists it, `hydrate()`/all read paths return it.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/observations-store.test.ts`, update the existing migration-count assertions (currently expecting 12 — this is a required update, not new content):

```typescript
  expect(rows).toHaveLength(13);
  expect(rows.map(r => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  expect(rows.map(r => r.name)).toEqual([
    'add_branch',
    'add_work_tokens',
    'add_stored_tokens',
    'add_retrieval_tracking',
    'add_retrieval_provenance',
    'add_dreaming_scaffold',
    'add_last_surfaced_source',
    'add_tide_lifecycle',
    'add_merge_events',
    'add_qm_runs',
    'add_promoted_at',
    'add_superseded_by',
    'add_origin_agent',
  ]);
```

Then add these new tests after the existing `'ObservationsStore — migration v10 adds qm_runs audit table'` test (or any convenient point after the migrations array definition):

```typescript
// ── C1: origin_agent vendor provenance (migration v13 + capture + back-compat) ──

test('ObservationsStore — migration v13 adds origin_agent column (nullable, no default)', () => {
  const db = new Database(join(workDir, 'observations.db'));
  const cols = db.query('PRAGMA table_info(observations)').all() as Array<{ name: string; dflt_value: unknown; notnull: number }>;
  const byName = new Map(cols.map(c => [c.name, c]));

  expect(byName.has('origin_agent')).toBe(true);
  expect(byName.get('origin_agent')!.dflt_value).toBeNull();
  expect(byName.get('origin_agent')!.notnull).toBe(0);
  expect(getAppliedVersions(db).some(v => v.version === 13)).toBe(true);
  db.close();
});

test('ObservationsStore — insert persists origin_agent and it roundtrips', () => {
  const id = store.insert({ ...tideBase, origin_agent: 'codex' });
  expect(store.findById(id)!.origin_agent).toBe('codex');
});

test('ObservationsStore — origin_agent defaults to null when omitted (back-compat)', () => {
  const id = store.insert({ ...tideBase });
  expect(store.findById(id)!.origin_agent).toBeNull();
});

test('ObservationsStore — pre-v13 rows (origin_agent column absent) hydrate as null', () => {
  const dbPath = join(workDir, 'legacy.db');
  const raw = new Database(dbPath);
  raw.exec(`CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL, project_id TEXT NOT NULL, prompt_number INTEGER NOT NULL,
    type TEXT NOT NULL, title TEXT NOT NULL, narrative TEXT NOT NULL DEFAULT '',
    facts TEXT NOT NULL DEFAULT '[]', concepts TEXT NOT NULL DEFAULT '[]',
    files_read TEXT NOT NULL DEFAULT '[]', files_modified TEXT NOT NULL DEFAULT '[]',
    created_at_epoch INTEGER NOT NULL);`);
  raw.run(
    `INSERT INTO observations (session_id, project_id, prompt_number, type, title, created_at_epoch)
     VALUES ('s','p',1,'change','legacy row',100)`,
  );
  raw.close();

  const migrated = new ObservationsStore(dbPath);
  const got = migrated.listRecent(1)[0]!;
  expect(got.origin_agent).toBeNull();
  const id = migrated.insert({ ...tideBase, origin_agent: 'claude-code' });
  expect(migrated.findById(id)!.origin_agent).toBe('claude-code');
  migrated.close();
});

test('ObservationsStore — migration v13 is idempotent on a DB that already has the column', () => {
  const dbPath = join(workDir, 'observations.db');
  store.close();
  const reopened = new ObservationsStore(dbPath);
  const id = reopened.insert({ ...tideBase, origin_agent: 'gemini' });
  expect(reopened.findById(id)!.origin_agent).toBe('gemini');
  reopened.close();

  const db = new Database(dbPath, { readonly: true });
  const v13 = getAppliedVersions(db).filter(v => v.version === 13);
  expect(v13).toHaveLength(1);
  db.close();
  store = new ObservationsStore(dbPath);   // restore for afterEach
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/observations-store.test.ts`
Expected: FAIL — the migration-count test fails first (`expected 13, received 12`), and the new `origin_agent`-specific tests fail with `origin_agent` being `undefined` on hydrated rows.

- [ ] **Step 3: Implement — migration, `NewObservation`, insert, hydrate**

In `src/worker/observations-store.ts`, add the import near the top:

```typescript
import { asOriginAgent } from '../shared/origin-agent.ts';
import type { OriginAgent } from '../shared/origin-agent.ts';
```

Add the new migration after the `version: 12, name: 'add_superseded_by'` entry (before the closing `];` of `OBSERVATIONS_STORE_MIGRATIONS`):

```typescript
  {
    // v13 — C1 vendor provenance: tag each observation with the AI agent that
    // authored it, mirroring how federation tags origin_peer at the captain
    // layer. Nullable with NO default: pre-v13 rows stay NULL (rendered
    // 'unknown' to consumers), and a hook that sends no agent signal also
    // stores NULL. Purely additive — the live recall path never filters on
    // it; it's carried into chunk/document metadata so search / get_full can
    // surface who wrote a memory.
    version: 13,
    name: 'add_origin_agent',
    up: (db) => db.exec('ALTER TABLE observations ADD COLUMN origin_agent TEXT'),
  },
];
```

Change the `NewObservation` type to make `origin_agent` optional (it's required on `Observation` but callers that don't know about it yet must still compile):

```typescript
export type NewObservation = Omit<
  Observation,
  'id' | 'stored_tokens'
  | 'retrieval_count' | 'last_retrieved_at'
  | 'from_auto' | 'from_search' | 'from_drill'
  | 'last_surfaced_at' | 'last_surfaced_source'
  | 'archived' | 'archived_into_theme_id' | 'theme_member_ids'
  | 'stability_days' | 'tide_state' | 'tide_state_changed_at' | 'is_anchored'
  | 'superseded_by' | 'origin_agent'
> & { origin_agent?: OriginAgent | null };
```

In `insert()`, add the column to the INSERT statement and bound params:

```typescript
  insert(obs: NewObservation): number {
    const result = this.db
      .query(
        `INSERT INTO observations
          (session_id, project_id, prompt_number, type, title, narrative,
           facts, concepts, files_read, files_modified, created_at_epoch, branch, work_tokens, origin_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        obs.session_id, obs.project_id, obs.prompt_number, obs.type, obs.title,
        obs.narrative,
        JSON.stringify(obs.facts),
        JSON.stringify(obs.concepts),
        JSON.stringify(obs.files_read),
        JSON.stringify(obs.files_modified),
        obs.created_at_epoch,
        obs.branch ?? null,
        obs.work_tokens ?? null,
        obs.origin_agent ?? null,
      );
    return Number(result.lastInsertRowid);
  }
```

In `hydrate()`, add the field after `branch: typeof row.branch === 'string' ? row.branch : null,`:

```typescript
      branch: typeof row.branch === 'string' ? row.branch : null,
      // Pre-v13 rows (no column) and rows captured with no agent signal read back
      // NULL; an unrecognized stored value also narrows to null (never throws).
      origin_agent: asOriginAgent(row.origin_agent),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/observations-store.test.ts`
Expected: PASS — all tests pass, including the updated migration-count test and all 5 new `origin_agent` tests.

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck 2>&1 | grep -i observations-store`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/worker/observations-store.ts tests/unit/observations-store.test.ts
git commit -m "feat(provenance): add migration v13 + store insert/read for origin_agent"
```

---

### Task 6: Worker HTTP wiring + integration tests

**Files:**
- Modify: `src/worker/index.ts:206-218` (`ObservationEnqueueSchema`), `src/worker/index.ts:645-659` (`ingestObservation`'s metadata), `src/worker/index.ts:705-719` (`processBatch`'s `obsStore.insert()`), `src/worker/index.ts:1915-1928` (`/observation/enqueue` handler)
- Test: `tests/integration/worker-observation.test.ts`

**Interfaces:**
- Consumes: `ORIGIN_AGENTS` from `../shared/origin-agent.ts`.
- Produces: `/observation/enqueue` accepts an optional `origin_agent` field; observations created through the summarizer pipeline carry it end-to-end into search/`get_full` result metadata.

- [ ] **Step 1: Write the failing tests**

In `tests/integration/worker-observation.test.ts`, add after the existing `'POST /observation/flush — empty queue returns processed=0'` test:

```typescript
test('capture writes origin_agent end-to-end (enqueue → flush → store)', async () => {
  await fetch(`http://localhost:${port}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 's-agent', project_id: 'p1', prompt_number: 1,
      tool_name: 'Edit', tool_input_summary: 'edit foo.ts', tool_result_summary: 'ok',
      files_read: [], files_modified: ['foo.ts'], ts_epoch: 1_700_000_000,
      origin_agent: 'codex',
    }),
  });
  await fetch(`http://localhost:${port}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's-agent' }),
  });

  const stored = worker.store!.listForSession('s-agent');
  expect(stored).toHaveLength(1);
  expect(stored[0]!.origin_agent).toBe('codex');
});

test('capture defaults origin_agent to null when the event omits it (back-compat)', async () => {
  await fetch(`http://localhost:${port}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 's-noagent', project_id: 'p1', prompt_number: 1,
      tool_name: 'Read', tool_input_summary: 'read foo.ts', tool_result_summary: 'ok',
      files_read: ['foo.ts'], files_modified: [], ts_epoch: 1_700_000_001,
    }),
  });
  await fetch(`http://localhost:${port}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's-noagent' }),
  });

  const stored = worker.store!.listForSession('s-noagent');
  expect(stored).toHaveLength(1);
  expect(stored[0]!.origin_agent).toBeNull();
});

test('search surfaces origin_agent in observation hit metadata', async () => {
  await fetch(`http://localhost:${port}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 's-search', project_id: 'p1', prompt_number: 1,
      tool_name: 'Edit', tool_input_summary: 'zorblax widget refactor', tool_result_summary: 'ok',
      files_read: [], files_modified: ['zorblax.ts'], ts_epoch: 1_700_000_002,
      origin_agent: 'gemini',
    }),
  });
  await fetch(`http://localhost:${port}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's-search' }),
  });

  const res = await fetch(`http://localhost:${port}/search/observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'zorblax widget', top_k: 5 }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { results: Array<{ metadata: Record<string, unknown> }> };
  expect(body.results.length).toBeGreaterThan(0);
  expect(body.results[0]!.metadata.origin_agent).toBe('gemini');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/integration/worker-observation.test.ts`
Expected: FAIL — `/observation/enqueue` returns 400 (`origin_agent` not in the Zod schema, but Zod schemas without `.strict()` merely ignore unknown keys, so more precisely: enqueue succeeds but `origin_agent` never reaches storage) — `stored[0]!.origin_agent` is `undefined`/fails the `toBe`/`toBeNull` assertions.

- [ ] **Step 3: Implement**

In `src/worker/index.ts`, add the import near the other shared imports:

```typescript
import { ORIGIN_AGENTS, UNKNOWN_ORIGIN_AGENT } from '../shared/origin-agent.ts';
```

In `ObservationEnqueueSchema`, add after `branch: z.string().nullable().optional(),`:

```typescript
const ObservationEnqueueSchema = z.object({
  session_id: z.string().min(1),
  project_id: z.string().min(1),
  prompt_number: z.number().int().nonnegative(),
  tool_name: z.string().min(1),
  tool_input_summary: z.string().max(2000),
  tool_result_summary: z.string().max(2000),
  files_read: z.array(z.string()).default([]),
  files_modified: z.array(z.string()).default([]),
  ts_epoch: z.number().int(),
  branch: z.string().nullable().optional(),
  // Vendor provenance: which AI agent captured this event. Absent or non-
  // conforming (.catch) → undefined at the schema layer → omitted downstream,
  // rendered 'unknown'. Plain .optional() alone would 400 on a garbage value
  // (only absence is tolerated) — .catch(undefined) is what makes it graceful.
  origin_agent: z.enum([...ORIGIN_AGENTS]).optional().catch(undefined),
  source: z.string().optional(),
});
```

In `ingestObservation`'s `metadata` object (inside `meta.upsertDocument`), add after `branch: obs.branch ?? null,`:

```typescript
      metadata: {
        observation_id: obs.id,
        session_id: obs.session_id,
        type: obs.type,
        title: obs.title,
        created_at_epoch: obs.created_at_epoch,
        branch: obs.branch ?? null,
        origin_agent: obs.origin_agent ?? UNKNOWN_ORIGIN_AGENT,
      },
```

In `processBatch`'s `obsStore.insert()` call, add after `branch: head.branch ?? null,`:

```typescript
        const id = obsStore.insert({
          session_id: head.session_id,
          project_id: head.project_id,
          prompt_number: head.prompt_number,
          type: summary.type,
          title: summary.title,
          narrative: summary.narrative,
          facts: summary.facts,
          concepts: summary.concepts,
          files_read: dedupeFlat(events.map(e => e.files_read)),
          files_modified: dedupeFlat(events.map(e => e.files_modified)),
          created_at_epoch: head.ts_epoch,
          branch: head.branch ?? null,
          origin_agent: head.origin_agent ?? null,
          work_tokens: workTokens,
        });
```

In the `/observation/enqueue` handler, add `origin_agent` to the destructure and pass it through only when defined:

```typescript
        const { branch, source, origin_agent, ...rest } = parsed.data;
        const id = obsQueue.enqueue({
          ...rest,
          branch: branch ?? null,
          ...(origin_agent !== undefined && { origin_agent }),
          ...(source !== undefined && { source }),
        });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/integration/worker-observation.test.ts`
Expected: PASS — all tests pass, including the 3 new `origin_agent` tests.

- [ ] **Step 5: Commit**

```bash
git add src/worker/index.ts tests/integration/worker-observation.test.ts
git commit -m "feat(provenance): wire origin_agent through worker enqueue/summarize/surface"
```

---

### Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: zero errors attributable to this feature. (Pre-existing, unrelated errors — if any — are out of scope; confirm any surviving error also existed before this plan's first commit via `git stash` + re-run, or by checking it references files this plan never touched.)

- [ ] **Step 2: Full test suite**

Run: `bun run test:unit && bun test tests/integration/`
Expected: 100% pass, no regressions in unrelated suites.

- [ ] **Step 3: Manual smoke check of the enum in the CLI cross-ai matrix**

Run: `grep -n "id: '" src/cli/cross-ai.ts | wc -l` — confirm it still reports 7 (the `ADAPTERS` array is untouched by this plan; this just confirms no accidental edit happened to that file).

- [ ] **Step 4: No commit needed** (verification-only task).

---

### Task 8: Mirror the identical patch to `captain-memo-fed` (federation)

**Files:** the same 9 files as Tasks 1–6, applied to the `captain-memo-fed` checkout (`federation` branch), at `/home/kalin/projects/captain-memo-fed`.

**Interfaces:** none new — this is a repeat of Tasks 1–6's exact diffs on a separate checkout, so both branches' schemas stay at `v13` in lockstep.

- [ ] **Step 1: Confirm federation's migration numbering is still v12 at the top**

Run (in `/home/kalin/projects/captain-memo-fed`): `grep -n "version:" src/worker/observations-store.ts | tail -3`
Expected: highest version is still `12` (`add_superseded_by`). If federation has since advanced past `v12`, STOP and pick the next free version number instead of `13` — do not silently overwrite an unrelated migration.

- [ ] **Step 2: Apply Tasks 1–6 verbatim**

Repeat every step from Tasks 1 through 6 against the `/home/kalin/projects/captain-memo-fed` checkout. Federation's file line numbers may differ slightly from OSS master's (it has extra federation-only code interleaved) — locate each anchor by its surrounding code (e.g. `branch: detectBranchSync(process.cwd()),`) rather than by absolute line number.

- [ ] **Step 3: Run federation's own typecheck + full test suite**

Run: `bun run typecheck && bun run test:unit`
Expected: zero errors, all tests pass — same bar as OSS master's Task 7.

- [ ] **Step 4: Commit and push to `gitlab federation`**

```bash
git add -A
git commit -m "feat(provenance): add origin_agent vendor tagging (mirrors OSS master, C1)"
git push gitlab federation
```

(Confirm with the user before this push, per the standing "never push without explicit instruction" rule — this step describes the mechanics; do not execute it silently.)
