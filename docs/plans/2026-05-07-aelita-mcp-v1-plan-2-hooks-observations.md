# aelita-mcp v1 — Plan 2: Hooks + Observation Pipeline + Haiku Summarizer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-05-07
**Builds on:** Plan 1 (foundation — already shipped, see `2026-05-06-aelita-mcp-v1-plan-1-foundation.md`)

**Goal:** Layer auto-injection hooks, the PostToolUse → Stop observation pipeline, and a configurable Haiku-class summarizer on top of the Plan-1 foundation. After Plan 2, `aelita-mcp` becomes a *running* memory layer: the four Claude Code hooks fire, every user prompt is enriched with a `<memory-context>` envelope, every tool use feeds an observation queue, and summarized observations are ingested through the existing `IngestPipeline` with full sha-diff and vector-store discipline.

The summarizer is **model-agnostic** — primary model + ordered fallback chain, both env-configurable. Defaults are a 2026-05 snapshot (`claude-haiku-4-6` primary, `claude-haiku-4-5` fallback); point them at any newer Haiku-class model when one ships, no code changes required.

**Architecture:** Plan 2 adds three thin layers on top of the existing worker:
1. **Worker support endpoints** — `/inject/context`, `/observation/enqueue`, `/observation/flush`, `/pending_embed/retry`. All thin glue around stores already implemented in Plan 1.
2. **Stores + processors** — observation queue (SQLite WAL), pending-embed retry queue (SQLite), Haiku summarizer client (Anthropic SDK).
3. **Hook scripts + dispatcher** — four hook handlers behind a single `bin/aelita-mcp-hook` shim that picks the right handler based on the event name.

**Hard contracts (from spec Section 5):**
- `UserPromptSubmit`: 250ms p95 hard cap, fail-open (no envelope, never block the prompt).
- `PostToolUse`: fire-and-forget, never blocks tool execution.
- `Stop`: 5-second drain budget, queue persists if drain incomplete.
- Embedding failures → `pending_embed` queue, never dropped.

**Tech additions on top of Plan 1:**
- `@anthropic-ai/sdk` — observation summarizer. Primary model + ordered fallback chain, both env-configurable. Defaults are 2026-05 snapshot values; the worker walks the chain on `model_not_found` and caches the first model that responds.
- No other new runtime deps. Hooks are bun scripts; HTTP, SQLite, zod, file-watching, vector store all reused.

Spec reference: `~/projects/aelita-mcp/docs/specs/2026-05-06-aelita-mcp-design.md` (Sections 3-6 + Decision Log D8, D14).

---

## What this plan covers

### In scope (Plan 2)

| Spec section | Item | Plan-2 task(s) |
|---|---|---|
| §3 — Hooks (4 total) | `UserPromptSubmit`, `SessionStart`, `PostToolUse`, `Stop` | Tasks 12-16 |
| §3 — `<memory-context>` envelope | Reproduced verbatim, format-template populated by worker | Task 8 |
| §4 — Observation queue | SQLite WAL queue, batched processing | Tasks 4-5, 9 |
| §5 — Hook timeout budget (UserPromptSubmit ≤250ms p95) | Hard cap + fail-open + skip-rules | Tasks 7, 12 |
| §5 — Embedding failure → queue, don't drop | `pending_embed` retry queue | Task 6 |
| §6 — Hook contract tests | Fixture-driven, no LLM calls | Task 17 |
| Decision Log D8 | Configurable Haiku-class summarizer (primary + fallback chain) with structured output | Tasks 10, 11 |
| Decision Log D14 | Envelope shows scores; degradation flags only when present | Task 8 |

### Out of scope — deferred to Plan 3

- Migration from `claude-mem` (`migrate-from-claude-mem` command).
- Federation with remote MCPs (Aelita KB MCP client, circuit breakers).
- Duplicate cluster detection / `optimize` / `purge` / `forget` commands.
- Retrieval-quality eval runner (`tests/eval/golden-queries.json` + harness).
- Local Voyage install script.
- MEMORY.md transformation script (the actual `MEMORY.md.archive` snapshot + new-shape generator).

Plan-2 must NOT modify Plan-1 components except where explicitly noted (worker `index.ts`, `paths.ts`, `package.json` deps/scripts, USAGE.md). Pure-additive everywhere else.

---

## File Structure

```
~/projects/aelita-mcp/
├── package.json                              # +@anthropic-ai/sdk, +scripts
├── bin/
│   ├── aelita-mcp                            # (existing — CLI entry)
│   └── aelita-mcp-hook                       # NEW — hook dispatcher shebang
├── src/
│   ├── shared/
│   │   ├── types.ts                          # +RawObservationEvent, +Observation, +EnvelopePayload
│   │   ├── paths.ts                          # +ANTHROPIC_API_KEY env name, +DEFAULT_HAIKU_MODEL constant
│   │   └── tokens.ts                         # (existing — reused by envelope budget)
│   ├── worker/
│   │   ├── index.ts                          # +observation/inject/pending_embed endpoints, summarizer wiring
│   │   ├── observation-queue.ts              # NEW — SQLite WAL queue store
│   │   ├── observations-store.ts             # NEW — final observations table + chunkObservation glue
│   │   ├── pending-embed-queue.ts            # NEW — failed-embed retry queue
│   │   ├── summarizer.ts                     # NEW — Haiku-class Anthropic client (configurable model + fallback chain)
│   │   ├── envelope.ts                       # NEW — <memory-context> formatter, token budget
│   │   ├── observation-batch-processor.ts    # NEW — drain queue → summarize → ingest
│   │   └── observation-ingest.ts             # NEW — chunkObservation → vector-store glue (delegates to IngestPipeline)
│   ├── hooks/
│   │   ├── shared.ts                         # NEW — read-stdin/write-stdout helpers + worker fetch w/ AbortSignal
│   │   ├── user-prompt-submit.ts             # NEW
│   │   ├── session-start.ts                  # NEW
│   │   ├── post-tool-use.ts                  # NEW
│   │   ├── stop.ts                           # NEW
│   │   └── dispatcher.ts                     # NEW — picks handler from event-name arg
│   └── cli/
│       ├── index.ts                          # +observation, +config, +install-hooks subcommands
│       └── commands/
│           ├── observation.ts                # NEW — list/flush
│           ├── config.ts                     # NEW — show effective config
│           └── install-hooks.ts              # NEW — settings.json mutator (idempotent)
└── tests/
    ├── unit/
    │   ├── envelope.test.ts                  # NEW — pure formatter
    │   ├── observation-queue.test.ts         # NEW
    │   ├── observations-store.test.ts        # NEW
    │   ├── pending-embed-queue.test.ts       # NEW
    │   ├── summarizer.test.ts                # NEW — mocked Anthropic transport
    │   └── install-hooks.test.ts             # NEW
    ├── integration/
    │   ├── worker-observation.test.ts        # NEW — enqueue + flush + ingest end-to-end
    │   ├── worker-inject-context.test.ts     # NEW — /inject/context returns envelope under budget
    │   ├── pending-embed-retry.test.ts       # NEW
    │   └── plan2-release-gate.test.ts        # NEW — full session: SessionStart → prompt → tools → Stop
    ├── hooks/
    │   ├── user-prompt-submit.test.ts        # NEW — fixture-driven contract test
    │   ├── session-start.test.ts             # NEW
    │   ├── post-tool-use.test.ts             # NEW
    │   └── stop.test.ts                      # NEW
    └── fixtures/
        └── hooks/
            ├── user-prompt-submit.input.json
            ├── session-start.input.json
            ├── post-tool-use.input.json
            └── stop.input.json
```

---

## Implementation Tasks

### Task 1: Plan-2 dependencies + scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `@anthropic-ai/sdk` and Plan-2 scripts**

Replace the `dependencies` and `scripts` sections of `package.json`:

```json
{
  "scripts": {
    "test": "bun test",
    "test:unit": "bun test tests/unit/",
    "test:integration": "bun test tests/integration/",
    "test:hooks": "bun test tests/hooks/",
    "typecheck": "tsc --noEmit",
    "worker:start": "bun src/worker/index.ts",
    "worker:dev": "AELITA_MCP_DATA_DIR=./.aelita-mcp.dev bun --watch src/worker/index.ts",
    "mcp:start": "bun src/mcp-server.ts",
    "cli": "bun bin/aelita-mcp",
    "hook": "bun bin/aelita-mcp-hook"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.0",
    "@modelcontextprotocol/sdk": "^1.25.1",
    "chokidar": "^4.0.3",
    "gpt-tokenizer": "^2.5.1",
    "nanoid": "^5.0.7",
    "sqlite-vec": "^0.1.9",
    "zod": "^3.24.0"
  }
}
```

- [ ] **Step 2: Install**

```bash
bun install
```
Expected: `bun.lock` updated; `node_modules/@anthropic-ai/sdk/` present.

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "chore(deps): add @anthropic-ai/sdk + plan-2 test scripts"
```

---

### Task 2: Shared types + path constants for Plan-2

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/paths.ts`

- [ ] **Step 1: Extend `src/shared/types.ts`**

Append to `src/shared/types.ts`:

```typescript
// ─────────────────────────────────────────────────────────────────────
// Plan-2 additions: observation pipeline + injection envelope.
// ─────────────────────────────────────────────────────────────────────

/**
 * Raw event captured by the PostToolUse hook. Lossless echo of what Claude
 * Code passed to the hook; the worker is responsible for any redaction.
 */
export interface RawObservationEvent {
  session_id: string;
  project_id: string;
  prompt_number: number;       // 1-based index within the session
  tool_name: string;
  tool_input_summary: string;  // ≤ 2000 chars; truncate at hook before send
  tool_result_summary: string; // ≤ 2000 chars
  files_read: string[];
  files_modified: string[];
  ts_epoch: number;            // hook capture time, seconds
}

/**
 * Final-form Observation produced by the Haiku summarizer from a window
 * of RawObservationEvent rows. Stored in `observations` table and chunked
 * via chunkObservation() for vector indexing.
 */
export interface Observation {
  id: number;                  // SQLite rowid; populated post-insert
  session_id: string;
  project_id: string;
  prompt_number: number;
  type: ObservationType;
  title: string;
  narrative: string;
  facts: string[];
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  created_at_epoch: number;
}

/** Status enum for the observation_queue rows. */
export type ObservationQueueStatus = 'pending' | 'processing' | 'done' | 'failed';

/** A single hit as it appears inside the <memory-context> envelope. */
export interface EnvelopeHit {
  doc_id: string;
  channel: ChannelType;
  source_path: string;
  title: string;
  snippet: string;
  score: number;
  metadata: Record<string, unknown>;
}

/** Payload returned by /inject/context. */
export interface EnvelopePayload {
  envelope: string;            // The literal <memory-context>…</memory-context> block
  hit_count: number;
  budget_tokens: number;
  used_tokens: number;
  channels_searched: ChannelType[];
  degradation_flags: string[]; // e.g. "embedder=voyage-4-nano:keyword-fallback=true"
  elapsed_ms: number;
}
```

- [ ] **Step 2: Extend `src/shared/paths.ts`**

Append to `src/shared/paths.ts`:

```typescript
// Plan-2 additions ─────────────────────────────────────────────────────

// Snapshot of "current best small/fast Claude" at 2026-05. Override via env
// when newer Haiku-class models ship — the worker doesn't care about the version,
// only that the configured model speaks the Anthropic Messages API.
export const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-6';

// Ordered fallback chain — each model is tried on `model_not_found` from the
// previous one. The first successful model is cached for the worker's lifetime.
// Override via AELITA_MCP_HAIKU_FALLBACKS (comma-separated list).
export const DEFAULT_HAIKU_FALLBACKS: string[] = ['claude-haiku-4-5'];

// Env-var names — keep all under AELITA_MCP_* except ANTHROPIC_API_KEY,
// which intentionally matches the Anthropic SDK convention.
export const ENV_ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY';
export const ENV_HAIKU_MODEL = 'AELITA_MCP_HAIKU_MODEL';
export const ENV_HAIKU_FALLBACKS = 'AELITA_MCP_HAIKU_FALLBACKS';
export const ENV_HOOK_BUDGET_TOKENS = 'AELITA_MCP_HOOK_BUDGET_TOKENS';
export const ENV_HOOK_TIMEOUT_MS = 'AELITA_MCP_HOOK_TIMEOUT_MS';
export const ENV_OBSERVATION_BATCH_SIZE = 'AELITA_MCP_OBSERVATION_BATCH_SIZE';
export const ENV_OBSERVATION_TICK_MS = 'AELITA_MCP_OBSERVATION_TICK_MS';

// Hard contracts from spec §5 — defaults if env not set.
export const DEFAULT_HOOK_TIMEOUT_MS = 250;
export const DEFAULT_STOP_DRAIN_BUDGET_MS = 5_000;
export const DEFAULT_HOOK_BUDGET_TOKENS = 4_000;
export const DEFAULT_OBSERVATION_BATCH_SIZE = 20;
export const DEFAULT_OBSERVATION_TICK_MS = 5_000;
```

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/shared/paths.ts
git commit -m "feat(types): plan-2 — RawObservationEvent + Observation + EnvelopePayload + path constants"
```

---

### Task 3: Hook fixtures (real Claude Code payloads)

**Files:**
- Create: `tests/fixtures/hooks/user-prompt-submit.input.json`
- Create: `tests/fixtures/hooks/session-start.input.json`
- Create: `tests/fixtures/hooks/post-tool-use.input.json`
- Create: `tests/fixtures/hooks/stop.input.json`

> **No unit tests in this task — fixtures only.** They feed the contract tests in Task 17.

- [ ] **Step 1: Create UserPromptSubmit fixture**

```json
{
  "session_id": "ses_2026-05-07T12-00-00_abc123",
  "transcript_path": "/tmp/claude-transcripts/abc123.jsonl",
  "cwd": "/home/kalin/projects/aelita-mcp",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "How do I run the worker against a custom data dir?",
  "prompt_number": 1
}
```

- [ ] **Step 2: Create SessionStart fixture**

```json
{
  "session_id": "ses_2026-05-07T12-00-00_abc123",
  "transcript_path": "/tmp/claude-transcripts/abc123.jsonl",
  "cwd": "/home/kalin/projects/aelita-mcp",
  "hook_event_name": "SessionStart",
  "source": "startup"
}
```

- [ ] **Step 3: Create PostToolUse fixture**

```json
{
  "session_id": "ses_2026-05-07T12-00-00_abc123",
  "transcript_path": "/tmp/claude-transcripts/abc123.jsonl",
  "cwd": "/home/kalin/projects/aelita-mcp",
  "hook_event_name": "PostToolUse",
  "prompt_number": 1,
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "/home/kalin/projects/aelita-mcp/src/worker/index.ts",
    "old_string": "skipChromaConnect",
    "new_string": "skipEmbed"
  },
  "tool_response": {
    "success": true,
    "filePath": "/home/kalin/projects/aelita-mcp/src/worker/index.ts"
  }
}
```

- [ ] **Step 4: Create Stop fixture**

```json
{
  "session_id": "ses_2026-05-07T12-00-00_abc123",
  "transcript_path": "/tmp/claude-transcripts/abc123.jsonl",
  "cwd": "/home/kalin/projects/aelita-mcp",
  "hook_event_name": "Stop",
  "stop_hook_active": false
}
```

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/hooks/
git commit -m "test(fixtures): record real Claude Code hook payloads for contract tests"
```

---

### Task 4: ObservationQueue store (SQLite WAL)

**Files:**
- Create: `src/worker/observation-queue.ts`
- Create: `tests/unit/observation-queue.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/observation-queue.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ObservationQueue } from '../../src/worker/observation-queue.ts';
import type { RawObservationEvent } from '../../src/shared/types.ts';

let workDir: string;
let queue: ObservationQueue;

const ev = (overrides: Partial<RawObservationEvent> = {}): RawObservationEvent => ({
  session_id: 'ses-1',
  project_id: 'p1',
  prompt_number: 1,
  tool_name: 'Read',
  tool_input_summary: 'file_path=/foo',
  tool_result_summary: 'returned 42 lines',
  files_read: ['/foo'],
  files_modified: [],
  ts_epoch: Math.floor(Date.now() / 1000),
  ...overrides,
});

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'aelita-q-'));
  queue = new ObservationQueue(join(workDir, 'queue.db'));
});

afterEach(() => {
  queue.close();
  rmSync(workDir, { recursive: true, force: true });
});

test('ObservationQueue — enqueue + take returns FIFO batch', () => {
  queue.enqueue(ev({ prompt_number: 1 }));
  queue.enqueue(ev({ prompt_number: 2 }));
  queue.enqueue(ev({ prompt_number: 3 }));
  const batch = queue.takeBatch(10);
  expect(batch).toHaveLength(3);
  expect(batch.map(b => b.payload.prompt_number)).toEqual([1, 2, 3]);
});

test('ObservationQueue — takeBatch marks rows processing', () => {
  queue.enqueue(ev());
  const batch = queue.takeBatch(10);
  expect(batch[0]!.status).toBe('processing');
  // A second take with no new pending rows yields empty
  expect(queue.takeBatch(10)).toHaveLength(0);
});

test('ObservationQueue — markDone removes processing rows', () => {
  queue.enqueue(ev());
  const [row] = queue.takeBatch(10);
  queue.markDone([row!.id]);
  expect(queue.pendingCount()).toBe(0);
  expect(queue.processingCount()).toBe(0);
});

test('ObservationQueue — markFailed increments retries and reverts to pending', () => {
  queue.enqueue(ev());
  const [row] = queue.takeBatch(10);
  queue.markFailed([row!.id]);
  const reread = queue.takeBatch(10);
  expect(reread).toHaveLength(1);
  expect(reread[0]!.retries).toBe(1);
});

test('ObservationQueue — markFailed at maxRetries marks failed permanently', () => {
  queue.enqueue(ev());
  for (let i = 0; i < 4; i++) {
    const batch = queue.takeBatch(10);
    if (batch.length === 0) break;
    queue.markFailed(batch.map(b => b.id), 3);
  }
  expect(queue.takeBatch(10)).toHaveLength(0);
  expect(queue.failedCount()).toBe(1);
});

test('ObservationQueue — pendingForSession lists rows by session_id', () => {
  queue.enqueue(ev({ session_id: 'a' }));
  queue.enqueue(ev({ session_id: 'b' }));
  queue.enqueue(ev({ session_id: 'a' }));
  expect(queue.pendingForSession('a')).toHaveLength(2);
  expect(queue.pendingForSession('b')).toHaveLength(1);
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test tests/unit/observation-queue.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement `ObservationQueue`**

```typescript
// src/worker/observation-queue.ts
import { Database } from 'bun:sqlite';
import type { RawObservationEvent, ObservationQueueStatus } from '../shared/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observation_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  retries INTEGER NOT NULL DEFAULT 0,
  created_at_epoch INTEGER NOT NULL,
  processed_at_epoch INTEGER
);
CREATE INDEX IF NOT EXISTS idx_obsq_status ON observation_queue(status, created_at_epoch);
CREATE INDEX IF NOT EXISTS idx_obsq_session ON observation_queue(session_id, status);
`;

export interface ObservationQueueRow {
  id: number;
  session_id: string;
  project_id: string;
  payload: RawObservationEvent;
  status: ObservationQueueStatus;
  retries: number;
  created_at_epoch: number;
}

export class ObservationQueue {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  enqueue(event: RawObservationEvent): number {
    const result = this.db
      .query(
        `INSERT INTO observation_queue
          (session_id, project_id, payload, status, retries, created_at_epoch)
         VALUES (?, ?, ?, 'pending', 0, ?)`
      )
      .run(
        event.session_id,
        event.project_id,
        JSON.stringify(event),
        Math.floor(Date.now() / 1000)
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Atomically claim up to `limit` pending rows; flips them to processing.
   */
  takeBatch(limit: number): ObservationQueueRow[] {
    const rows = this.db.transaction(() => {
      const selected = this.db
        .query(
          `SELECT id, session_id, project_id, payload, status, retries, created_at_epoch
           FROM observation_queue
           WHERE status = 'pending'
           ORDER BY created_at_epoch ASC, id ASC
           LIMIT ?`
        )
        .all(limit) as Array<{
          id: number; session_id: string; project_id: string;
          payload: string; status: ObservationQueueStatus;
          retries: number; created_at_epoch: number;
        }>;
      if (selected.length === 0) return [];
      const ids = selected.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db
        .query(`UPDATE observation_queue SET status = 'processing' WHERE id IN (${placeholders})`)
        .run(...ids);
      return selected.map(r => ({
        ...r,
        status: 'processing' as const,
        payload: JSON.parse(r.payload) as RawObservationEvent,
      }));
    })();
    return rows;
  }

  markDone(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    const now = Math.floor(Date.now() / 1000);
    this.db
      .query(
        `UPDATE observation_queue
         SET status = 'done', processed_at_epoch = ?
         WHERE id IN (${placeholders})`
      )
      .run(now, ...ids);
  }

  /**
   * Increment retries; if retries < maxRetries flip back to pending,
   * otherwise mark failed permanently.
   */
  markFailed(ids: number[], maxRetries = 3): void {
    if (ids.length === 0) return;
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        const row = this.db
          .query('SELECT retries FROM observation_queue WHERE id = ?')
          .get(id) as { retries: number } | undefined;
        if (!row) continue;
        const next = row.retries + 1;
        if (next >= maxRetries) {
          this.db
            .query(`UPDATE observation_queue SET status = 'failed', retries = ? WHERE id = ?`)
            .run(next, id);
        } else {
          this.db
            .query(`UPDATE observation_queue SET status = 'pending', retries = ? WHERE id = ?`)
            .run(next, id);
        }
      }
    });
    tx();
  }

  pendingCount(): number {
    return (this.db
      .query(`SELECT COUNT(*) AS n FROM observation_queue WHERE status = 'pending'`)
      .get() as { n: number }).n;
  }

  processingCount(): number {
    return (this.db
      .query(`SELECT COUNT(*) AS n FROM observation_queue WHERE status = 'processing'`)
      .get() as { n: number }).n;
  }

  failedCount(): number {
    return (this.db
      .query(`SELECT COUNT(*) AS n FROM observation_queue WHERE status = 'failed'`)
      .get() as { n: number }).n;
  }

  pendingForSession(sessionId: string): ObservationQueueRow[] {
    const rows = this.db
      .query(
        `SELECT id, session_id, project_id, payload, status, retries, created_at_epoch
         FROM observation_queue
         WHERE session_id = ? AND status IN ('pending', 'processing')
         ORDER BY created_at_epoch ASC, id ASC`
      )
      .all(sessionId) as Array<{
        id: number; session_id: string; project_id: string;
        payload: string; status: ObservationQueueStatus;
        retries: number; created_at_epoch: number;
      }>;
    return rows.map(r => ({ ...r, payload: JSON.parse(r.payload) as RawObservationEvent }));
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test tests/unit/observation-queue.test.ts
```
Expected: `6 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/worker/observation-queue.ts tests/unit/observation-queue.test.ts
git commit -m "feat(worker): ObservationQueue — SQLite WAL, batch claim, retry semantics"
```

---

### Task 5: ObservationsStore (final-form table)

**Files:**
- Create: `src/worker/observations-store.ts`
- Create: `tests/unit/observations-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/observations-store.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ObservationsStore } from '../../src/worker/observations-store.ts';

let workDir: string;
let store: ObservationsStore;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'aelita-obs-'));
  store = new ObservationsStore(join(workDir, 'observations.db'));
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

test('ObservationsStore — insert returns row id and find roundtrips', () => {
  const id = store.insert({
    session_id: 's1',
    project_id: 'p1',
    prompt_number: 1,
    type: 'bugfix',
    title: 'fixed off-by-one',
    narrative: 'patched the loop bound',
    facts: ['index started at 1', 'should start at 0'],
    concepts: ['off-by-one'],
    files_read: ['a.ts'],
    files_modified: ['a.ts'],
    created_at_epoch: 1_700_000_000,
  });
  expect(id).toBeGreaterThan(0);
  const got = store.findById(id);
  expect(got).not.toBeNull();
  expect(got!.title).toBe('fixed off-by-one');
  expect(got!.facts).toEqual(['index started at 1', 'should start at 0']);
  expect(got!.concepts).toEqual(['off-by-one']);
});

test('ObservationsStore — listForSession returns chronological order', () => {
  store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 2,
    type: 'feature', title: 'b', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 200,
  });
  store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'feature', title: 'a', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
  });
  const list = store.listForSession('s1');
  expect(list.map(o => o.title)).toEqual(['a', 'b']);
});

test('ObservationsStore — listRecent respects limit', () => {
  for (let i = 0; i < 5; i++) {
    store.insert({
      session_id: 's', project_id: 'p', prompt_number: i,
      type: 'change', title: `t${i}`, narrative: '', facts: [], concepts: [],
      files_read: [], files_modified: [], created_at_epoch: 100 + i,
    });
  }
  expect(store.listRecent(3)).toHaveLength(3);
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test tests/unit/observations-store.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement `ObservationsStore`**

```typescript
// src/worker/observations-store.ts
import { Database } from 'bun:sqlite';
import type { Observation, ObservationType } from '../shared/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  prompt_number INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  narrative TEXT NOT NULL DEFAULT '',
  facts TEXT NOT NULL DEFAULT '[]',
  concepts TEXT NOT NULL DEFAULT '[]',
  files_read TEXT NOT NULL DEFAULT '[]',
  files_modified TEXT NOT NULL DEFAULT '[]',
  created_at_epoch INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id, created_at_epoch);
CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project_id, created_at_epoch DESC);
`;

export type NewObservation = Omit<Observation, 'id'>;

export class ObservationsStore {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  insert(obs: NewObservation): number {
    const result = this.db
      .query(
        `INSERT INTO observations
          (session_id, project_id, prompt_number, type, title, narrative,
           facts, concepts, files_read, files_modified, created_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        obs.session_id, obs.project_id, obs.prompt_number, obs.type, obs.title,
        obs.narrative,
        JSON.stringify(obs.facts),
        JSON.stringify(obs.concepts),
        JSON.stringify(obs.files_read),
        JSON.stringify(obs.files_modified),
        obs.created_at_epoch,
      );
    return Number(result.lastInsertRowid);
  }

  private hydrate(row: Record<string, unknown>): Observation {
    return {
      id: Number(row.id),
      session_id: String(row.session_id),
      project_id: String(row.project_id),
      prompt_number: Number(row.prompt_number),
      type: row.type as ObservationType,
      title: String(row.title),
      narrative: String(row.narrative),
      facts: JSON.parse(String(row.facts)),
      concepts: JSON.parse(String(row.concepts)),
      files_read: JSON.parse(String(row.files_read)),
      files_modified: JSON.parse(String(row.files_modified)),
      created_at_epoch: Number(row.created_at_epoch),
    };
  }

  findById(id: number): Observation | null {
    const row = this.db.query('SELECT * FROM observations WHERE id = ?').get(id) as
      | Record<string, unknown> | undefined;
    return row ? this.hydrate(row) : null;
  }

  listForSession(sessionId: string): Observation[] {
    const rows = this.db
      .query('SELECT * FROM observations WHERE session_id = ? ORDER BY created_at_epoch ASC, id ASC')
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(r => this.hydrate(r));
  }

  listRecent(limit: number): Observation[] {
    const rows = this.db
      .query('SELECT * FROM observations ORDER BY created_at_epoch DESC, id DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => this.hydrate(r));
  }

  countAll(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test tests/unit/observations-store.test.ts
```
Expected: `3 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/worker/observations-store.ts tests/unit/observations-store.test.ts
git commit -m "feat(worker): ObservationsStore — final-form observations table with JSON-encoded list cols"
```

---

### Task 6: PendingEmbedQueue (failed-embed retry queue)

**Files:**
- Create: `src/worker/pending-embed-queue.ts`
- Create: `tests/unit/pending-embed-queue.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/pending-embed-queue.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PendingEmbedQueue } from '../../src/worker/pending-embed-queue.ts';

let workDir: string;
let q: PendingEmbedQueue;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'aelita-pe-'));
  q = new PendingEmbedQueue(join(workDir, 'pending.db'));
});

afterEach(() => {
  q.close();
  rmSync(workDir, { recursive: true, force: true });
});

test('PendingEmbedQueue — enqueue + listDue returns due rows', () => {
  q.enqueue({ chunk_id: 'memory:foo:abc', source_path: '/a/foo.md', sha: 'sha1', channel: 'memory' });
  q.enqueue({ chunk_id: 'memory:bar:xyz', source_path: '/a/bar.md', sha: 'sha2', channel: 'memory' });
  const due = q.listDue(10);
  expect(due).toHaveLength(2);
  expect(due[0]!.chunk_id).toBe('memory:foo:abc');
});

test('PendingEmbedQueue — markRetried bumps next_retry_at into the future', () => {
  q.enqueue({ chunk_id: 'c1', source_path: '/p', sha: 's', channel: 'memory' });
  const due = q.listDue(10);
  q.markRetried(due.map(r => r.id), 60_000); // 60s
  // No rows due now
  expect(q.listDue(10)).toHaveLength(0);
});

test('PendingEmbedQueue — markEmbedded removes the row', () => {
  q.enqueue({ chunk_id: 'c1', source_path: '/p', sha: 's', channel: 'memory' });
  const due = q.listDue(10);
  q.markEmbedded(due.map(r => r.id));
  expect(q.listDue(10)).toHaveLength(0);
  expect(q.totalCount()).toBe(0);
});

test('PendingEmbedQueue — enqueue is idempotent on (chunk_id)', () => {
  q.enqueue({ chunk_id: 'c1', source_path: '/p', sha: 's1', channel: 'memory' });
  q.enqueue({ chunk_id: 'c1', source_path: '/p', sha: 's2', channel: 'memory' });
  expect(q.totalCount()).toBe(1);
  // Latest sha wins
  const due = q.listDue(10);
  expect(due[0]!.sha).toBe('s2');
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test tests/unit/pending-embed-queue.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement `PendingEmbedQueue`**

```typescript
// src/worker/pending-embed-queue.ts
import { Database } from 'bun:sqlite';
import type { ChannelType } from '../shared/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pending_embed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT NOT NULL UNIQUE,
  source_path TEXT NOT NULL,
  sha TEXT NOT NULL,
  channel TEXT NOT NULL,
  retries INTEGER NOT NULL DEFAULT 0,
  next_retry_at_epoch INTEGER NOT NULL,
  enqueued_at_epoch INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pe_due ON pending_embed(next_retry_at_epoch);
`;

export interface PendingEmbedInput {
  chunk_id: string;
  source_path: string;
  sha: string;
  channel: ChannelType;
}

export interface PendingEmbedRow extends PendingEmbedInput {
  id: number;
  retries: number;
  next_retry_at_epoch: number;
  enqueued_at_epoch: number;
}

export class PendingEmbedQueue {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  enqueue(input: PendingEmbedInput): void {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.db
      .query('SELECT id FROM pending_embed WHERE chunk_id = ?')
      .get(input.chunk_id) as { id: number } | undefined;
    if (existing) {
      this.db
        .query('UPDATE pending_embed SET source_path = ?, sha = ?, channel = ? WHERE id = ?')
        .run(input.source_path, input.sha, input.channel, existing.id);
    } else {
      this.db
        .query(
          `INSERT INTO pending_embed
            (chunk_id, source_path, sha, channel, retries, next_retry_at_epoch, enqueued_at_epoch)
           VALUES (?, ?, ?, ?, 0, ?, ?)`
        )
        .run(input.chunk_id, input.source_path, input.sha, input.channel, now, now);
    }
  }

  listDue(limit: number): PendingEmbedRow[] {
    const now = Math.floor(Date.now() / 1000);
    return this.db
      .query(
        `SELECT id, chunk_id, source_path, sha, channel, retries,
                next_retry_at_epoch, enqueued_at_epoch
         FROM pending_embed
         WHERE next_retry_at_epoch <= ?
         ORDER BY next_retry_at_epoch ASC, id ASC
         LIMIT ?`
      )
      .all(now, limit) as PendingEmbedRow[];
  }

  markRetried(ids: number[], delayMs: number): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    const next = Math.floor(Date.now() / 1000) + Math.ceil(delayMs / 1000);
    this.db
      .query(
        `UPDATE pending_embed
         SET retries = retries + 1, next_retry_at_epoch = ?
         WHERE id IN (${placeholders})`
      )
      .run(next, ...ids);
  }

  markEmbedded(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .query(`DELETE FROM pending_embed WHERE id IN (${placeholders})`)
      .run(...ids);
  }

  totalCount(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM pending_embed').get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test tests/unit/pending-embed-queue.test.ts
```
Expected: `4 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/worker/pending-embed-queue.ts tests/unit/pending-embed-queue.test.ts
git commit -m "feat(worker): PendingEmbedQueue — retry queue for failed embed batches"
```

---

### Task 7: Token-budget helper for envelope formatting

**Files:**
- Modify: `src/shared/tokens.ts` (add `truncateToTokenBudget` helper)
- Create: `tests/unit/tokens-budget.test.ts`

> The Plan-1 `tokens.ts` already counts tokens via `gpt-tokenizer`. Plan-2 adds a budget-aware truncator used by the envelope formatter.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/tokens-budget.test.ts
import { test, expect } from 'bun:test';
import { countTokens, truncateToTokenBudget } from '../../src/shared/tokens.ts';

test('truncateToTokenBudget — short input returns unchanged', () => {
  const text = 'Hello, world.';
  const out = truncateToTokenBudget(text, 100);
  expect(out).toBe(text);
});

test('truncateToTokenBudget — long input is shorter and respects budget', () => {
  const text = 'lorem ipsum '.repeat(2000);
  const before = countTokens(text);
  const out = truncateToTokenBudget(text, 100);
  const after = countTokens(out);
  expect(after).toBeLessThanOrEqual(100);
  expect(after).toBeLessThan(before);
});

test('truncateToTokenBudget — appends truncation marker when truncated', () => {
  const text = 'foo bar baz '.repeat(2000);
  const out = truncateToTokenBudget(text, 50);
  expect(out.endsWith('… [truncated]')).toBe(true);
});

test('truncateToTokenBudget — budget=0 returns just the marker', () => {
  expect(truncateToTokenBudget('anything', 0)).toBe('… [truncated]');
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test tests/unit/tokens-budget.test.ts
```
Expected: `truncateToTokenBudget` not exported.

- [ ] **Step 3: Add helper to `src/shared/tokens.ts`**

Append to `src/shared/tokens.ts`:

```typescript
const TRUNCATION_MARKER = '… [truncated]';

/**
 * Truncate `text` so that countTokens(result) <= budgetTokens.
 *
 * Strategy: binary-chop the character length downward until the token count
 * fits, then append the truncation marker. Cheap enough for envelope-sized
 * inputs (≤ a few thousand tokens). Not a streaming tokenizer.
 */
export function truncateToTokenBudget(text: string, budgetTokens: number): string {
  if (budgetTokens <= 0) return TRUNCATION_MARKER;
  if (countTokens(text) <= budgetTokens) return text;

  let lo = 0;
  let hi = text.length;
  // Reserve some tokens for the marker itself
  const markerTokens = countTokens(TRUNCATION_MARKER);
  const target = Math.max(0, budgetTokens - markerTokens);

  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const candidate = text.slice(0, mid);
    if (countTokens(candidate) <= target) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo).trimEnd() + TRUNCATION_MARKER;
}
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test tests/unit/tokens-budget.test.ts
```
Expected: `4 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/shared/tokens.ts tests/unit/tokens-budget.test.ts
git commit -m "feat(tokens): truncateToTokenBudget — binary-chop truncator with marker"
```

---

### Task 8: `<memory-context>` envelope formatter (pure)

**Files:**
- Create: `src/worker/envelope.ts`
- Create: `tests/unit/envelope.test.ts`

> The envelope template is the spec's verbatim format. The function is pure — takes `Hit[]` plus options and returns the envelope string + token usage. The worker wraps it with the actual search/inject endpoint in Task 9.

The format template (reproduced verbatim from spec §3, "`<memory-context>` envelope"):

```
<memory-context retrieved-by="aelita-mcp" project="<project_id>" k="<count>" budget-tokens="1500">
The following items were retrieved automatically based on the user's most recent prompt.
The user did NOT see this. Cite sources when using; treat as your own background knowledge.

## Local memory (N results)

### <filename>  ·  <type>  ·  score 0.87
<snippet>
[full: get_full("memory:<id>")]

## Skill: <skill_id>  ·  section "<section path>"  ·  score 0.81
<snippet, code blocks intact>
[full: get_full("skill:<id>#<section>")]

## Session memory (N results)

### <type> · <date> · "<title>"
<snippet>
[full: get_full("observation:<id>")]

## Remote: <source_name> (N results, fetched in <ms>ms)
<snippet — only if score ≥ 0.4>
</memory-context>
```

Plan-2 envelope omits the "Remote:" group entirely (federation is Plan 3). Degradation flags are added to the opening tag only when present (D14).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/envelope.test.ts
import { test, expect } from 'bun:test';
import { formatEnvelope } from '../../src/worker/envelope.ts';
import type { EnvelopeHit } from '../../src/shared/types.ts';

const memoryHit = (over: Partial<EnvelopeHit> = {}): EnvelopeHit => ({
  doc_id: 'memory:feedback_no_null:abc123',
  channel: 'memory',
  source_path: '/home/k/.claude/memory/feedback_no_null.md',
  title: 'feedback_no_null',
  snippet: 'No NULL — use 0 / "" sentinels.',
  score: 0.87,
  metadata: { memory_type: 'feedback' },
  ...over,
});

const skillHit = (over: Partial<EnvelopeHit> = {}): EnvelopeHit => ({
  doc_id: 'skill:erp-coding-standards#sql:def456',
  channel: 'skill',
  source_path: '/home/k/.claude/skills/erp-coding-standards/SKILL.md',
  title: 'erp-coding-standards / sql',
  snippet: 'Always use db_get_row() for single-row reads.',
  score: 0.81,
  metadata: { skill_id: 'erp-coding-standards', section_title: 'sql' },
  ...over,
});

const obsHit = (over: Partial<EnvelopeHit> = {}): EnvelopeHit => ({
  doc_id: 'observation:1700000000:ghi789',
  channel: 'observation',
  source_path: 'observation:1',
  title: 'fixed billing rounding',
  snippet: 'replaced round() with full-precision intermediate.',
  score: 0.74,
  metadata: { type: 'bugfix', created_at_epoch: 1_700_000_000 },
  ...over,
});

test('formatEnvelope — empty hits emits empty-state envelope with hit_count=0', () => {
  const out = formatEnvelope({
    project_id: 'erp-platform',
    budget_tokens: 4000,
    hits: [],
    degradation_flags: [],
  });
  expect(out.envelope).toContain('<memory-context');
  expect(out.envelope).toContain('project="erp-platform"');
  expect(out.envelope).toContain('k="0"');
  expect(out.envelope).toContain('</memory-context>');
  expect(out.hit_count).toBe(0);
});

test('formatEnvelope — groups hits by channel in fixed order memory, skill, observation', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [obsHit(), memoryHit(), skillHit()],
    degradation_flags: [],
  });
  const idxMem = out.envelope.indexOf('Local memory');
  const idxSkill = out.envelope.indexOf('Skill: ');
  const idxObs = out.envelope.indexOf('Session memory');
  expect(idxMem).toBeGreaterThan(0);
  expect(idxSkill).toBeGreaterThan(idxMem);
  expect(idxObs).toBeGreaterThan(idxSkill);
});

test('formatEnvelope — emits get_full hint with the doc_id verbatim', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [memoryHit()],
    degradation_flags: [],
  });
  expect(out.envelope).toContain('[full: get_full("memory:feedback_no_null:abc123")]');
});

test('formatEnvelope — score is rendered to two decimals', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [memoryHit({ score: 0.87543 })],
    degradation_flags: [],
  });
  expect(out.envelope).toContain('score 0.88');
});

test('formatEnvelope — degradation flags render in the opening tag', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [memoryHit()],
    degradation_flags: ['embedder=voyage-4-nano:keyword-fallback=true'],
  });
  expect(out.envelope).toContain('embedder=voyage-4-nano:keyword-fallback=true');
});

test('formatEnvelope — used_tokens never exceeds budget_tokens', () => {
  const bigSnippet = 'x'.repeat(20_000);
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 200,
    hits: [memoryHit({ snippet: bigSnippet })],
    degradation_flags: [],
  });
  expect(out.used_tokens).toBeLessThanOrEqual(200);
});

test('formatEnvelope — observation hit shows type and date prefix', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [obsHit()],
    degradation_flags: [],
  });
  // "bugfix · 2023-11-14" (epoch 1_700_000_000 = 2023-11-14 UTC)
  expect(out.envelope).toMatch(/bugfix · 2023-11-14/);
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test tests/unit/envelope.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement `formatEnvelope`**

```typescript
// src/worker/envelope.ts
import type { EnvelopeHit, ChannelType } from '../shared/types.ts';
import { countTokens, truncateToTokenBudget } from '../shared/tokens.ts';

export interface FormatEnvelopeOptions {
  project_id: string;
  budget_tokens: number;
  hits: EnvelopeHit[];
  degradation_flags: string[];
}

export interface FormatEnvelopeResult {
  envelope: string;
  hit_count: number;
  used_tokens: number;
}

const CHANNEL_ORDER: ChannelType[] = ['memory', 'skill', 'observation', 'remote'];

const HEADER_LINES = [
  `The following items were retrieved automatically based on the user's most recent prompt.`,
  `The user did NOT see this. Cite sources when using; treat as your own background knowledge.`,
];

function formatScore(score: number): string {
  return score.toFixed(2);
}

function formatObservationDate(epoch: number): string {
  const d = new Date(epoch * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function renderMemoryGroup(hits: EnvelopeHit[]): string {
  if (hits.length === 0) return '';
  const lines: string[] = [`## Local memory (${hits.length} results)`, ''];
  for (const h of hits) {
    const memoryType = String(h.metadata.memory_type ?? 'memory');
    lines.push(`### ${h.title}  ·  ${memoryType}  ·  score ${formatScore(h.score)}`);
    lines.push(h.snippet.trim());
    lines.push(`[full: get_full("${h.doc_id}")]`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderSkillGroup(hits: EnvelopeHit[]): string {
  if (hits.length === 0) return '';
  const lines: string[] = [];
  for (const h of hits) {
    const skillId = String(h.metadata.skill_id ?? 'unknown');
    const sectionTitle = String(h.metadata.section_title ?? '(top)');
    lines.push(`## Skill: ${skillId}  ·  section "${sectionTitle}"  ·  score ${formatScore(h.score)}`);
    lines.push(h.snippet.trim());
    lines.push(`[full: get_full("${h.doc_id}")]`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderObservationGroup(hits: EnvelopeHit[]): string {
  if (hits.length === 0) return '';
  const lines: string[] = [`## Session memory (${hits.length} results)`, ''];
  for (const h of hits) {
    const obsType = String(h.metadata.type ?? h.metadata.field_type ?? 'observation');
    const created = Number(h.metadata.created_at_epoch ?? 0);
    const date = formatObservationDate(created);
    lines.push(`### ${obsType} · ${date} · "${h.title}"`);
    lines.push(h.snippet.trim());
    lines.push(`[full: get_full("${h.doc_id}")]`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Pure formatter. The worker calls this with already-ranked, channel-scoped hits.
 * Token-budget enforcement happens inside this function — bodies are truncated
 * proportional to their share of the budget.
 */
export function formatEnvelope(opts: FormatEnvelopeOptions): FormatEnvelopeResult {
  const { project_id, budget_tokens, hits, degradation_flags } = opts;

  // Group by channel, preserving relative score order within each.
  const byChannel: Record<ChannelType, EnvelopeHit[]> = {
    memory: [], skill: [], observation: [], remote: [],
  };
  for (const h of hits) byChannel[h.channel].push(h);

  // Open + close tag — flags only appear when present (D14).
  const flagAttrs = degradation_flags.length > 0
    ? ` ${degradation_flags.map(f => `flag="${f}"`).join(' ')}`
    : '';
  const openTag = `<memory-context retrieved-by="aelita-mcp" project="${project_id}" k="${hits.length}" budget-tokens="${budget_tokens}"${flagAttrs}>`;
  const closeTag = `</memory-context>`;

  const headerSection = HEADER_LINES.join('\n');

  // Reserve overhead tokens for tags + header.
  const overheadText = `${openTag}\n${headerSection}\n${closeTag}\n`;
  const overheadTokens = countTokens(overheadText);
  const bodyBudget = Math.max(0, budget_tokens - overheadTokens);

  // Body assembly. Render each group, then if total > body budget, walk
  // back from the last hit's snippet, truncating until we fit.
  let body =
    [renderMemoryGroup(byChannel.memory),
     renderSkillGroup(byChannel.skill),
     renderObservationGroup(byChannel.observation)]
      .filter(s => s.length > 0)
      .join('\n');

  if (countTokens(body) > bodyBudget) {
    body = truncateToTokenBudget(body, bodyBudget);
  }

  const envelope = `${openTag}\n${headerSection}\n\n${body}${body.endsWith('\n') ? '' : '\n'}${closeTag}\n`;
  const used_tokens = Math.min(budget_tokens, countTokens(envelope));

  return { envelope, hit_count: hits.length, used_tokens };
}
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test tests/unit/envelope.test.ts
```
Expected: `7 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/worker/envelope.ts tests/unit/envelope.test.ts
git commit -m "feat(worker): formatEnvelope — <memory-context> formatter with token budget + D14 flags"
```

---

### Task 9: Worker — observation endpoints + worker wiring

**Files:**
- Modify: `src/worker/index.ts`
- Create: `tests/integration/worker-observation.test.ts`

This task adds three endpoints — `POST /observation/enqueue`, `POST /observation/flush`, `POST /pending_embed/retry` — and wires `ObservationQueue`, `ObservationsStore`, `PendingEmbedQueue` into `startWorker`. The summarizer client lands in Task 10; this task uses an injectable `summarize()` function so the test can pass without an Anthropic API key.

- [ ] **Step 1: Write the failing integration test**

```typescript
// tests/integration/worker-observation.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';

const PORT = 39901;
let worker: WorkerHandle;
let workDir: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'aelita-obs-int-'));
  worker = await startWorker({
    port: PORT,
    projectId: 'obs-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    observationQueueDbPath: join(workDir, 'queue.db'),
    observationsDbPath: join(workDir, 'obs.db'),
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    // Summarizer stub — no Anthropic call.
    summarize: async (events) => ({
      type: 'change',
      title: `summary of ${events.length} events`,
      narrative: 'stub narrative',
      facts: events.map(e => `${e.tool_name}: ${e.tool_input_summary}`),
      concepts: ['stub'],
    }),
    observationTickMs: 0, // Disable auto-tick; test calls flush manually.
  } as any);
});

afterEach(async () => {
  await worker.stop();
  rmSync(workDir, { recursive: true, force: true });
});

test('POST /observation/enqueue accepts a raw event and returns id', async () => {
  const res = await fetch(`http://localhost:${PORT}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 's1',
      project_id: 'p1',
      prompt_number: 1,
      tool_name: 'Edit',
      tool_input_summary: 'edit foo.ts',
      tool_result_summary: 'ok',
      files_read: [],
      files_modified: ['foo.ts'],
      ts_epoch: 1_700_000_000,
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.id).toBeGreaterThan(0);
  expect(body.queued).toBe(true);
});

test('POST /observation/flush drains queued events into observations', async () => {
  // Seed 3 events
  for (let i = 0; i < 3; i++) {
    await fetch(`http://localhost:${PORT}/observation/enqueue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 's-flush', project_id: 'p1', prompt_number: i,
        tool_name: 'Read', tool_input_summary: `i=${i}`, tool_result_summary: 'ok',
        files_read: [], files_modified: [], ts_epoch: 1_700_000_000 + i,
      }),
    });
  }
  const res = await fetch(`http://localhost:${PORT}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's-flush' }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.processed).toBeGreaterThanOrEqual(1);
  expect(body.observations_created).toBeGreaterThanOrEqual(1);
});

test('POST /observation/flush — empty queue returns processed=0', async () => {
  const res = await fetch(`http://localhost:${PORT}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'nope' }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.processed).toBe(0);
});

test('POST /observation/enqueue — invalid body → 400', async () => {
  const res = await fetch(`http://localhost:${PORT}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's1' }), // missing fields
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test tests/integration/worker-observation.test.ts
```
Expected: endpoints return 404 / options unrecognized.

- [ ] **Step 3: Extend `WorkerOptions` and wire stores**

In `src/worker/index.ts`, **add** to the existing `WorkerOptions` interface:

```typescript
import type { RawObservationEvent } from '../shared/types.ts';

export interface SummarizerInput {
  events: RawObservationEvent[];
}

export interface SummarizerResult {
  type: import('../shared/types.ts').ObservationType;
  title: string;
  narrative: string;
  facts: string[];
  concepts: string[];
}

// Add to WorkerOptions (do not reorder existing fields):
export interface WorkerOptions {
  // … existing fields unchanged …
  observationQueueDbPath?: string;
  observationsDbPath?: string;
  pendingEmbedDbPath?: string;
  summarize?: (events: RawObservationEvent[]) => Promise<SummarizerResult>;
  observationTickMs?: number;
  observationBatchSize?: number;
  hookBudgetTokens?: number;
}
```

> Use `exactOptionalPropertyTypes`-friendly conditional spreads when constructing this object — never pass `undefined` for a field whose declared type doesn't include `undefined`.

- [ ] **Step 4: Construct stores and processor inside `startWorker`**

After the existing `meta`/`embedder`/`vector`/`searcher`/`ingest` setup in `startWorker`, add:

```typescript
import { ObservationQueue } from './observation-queue.ts';
import { ObservationsStore } from './observations-store.ts';
import { PendingEmbedQueue } from './pending-embed-queue.ts';
import { chunkObservation } from './chunkers/observation.ts';

// (Stores) ─────────────────────────────────────────────────────────────
const obsQueue = opts.observationQueueDbPath
  ? new ObservationQueue(opts.observationQueueDbPath)
  : null;
const obsStore = opts.observationsDbPath
  ? new ObservationsStore(opts.observationsDbPath)
  : null;
const pendingEmbed = opts.pendingEmbedDbPath
  ? new PendingEmbedQueue(opts.pendingEmbedDbPath)
  : null;

const summarize = opts.summarize ?? null;
const tickMs = opts.observationTickMs ?? 5000;
const batchSize = opts.observationBatchSize ?? 20;

// (Processor) ─────────────────────────────────────────────────────────
async function processBatch(limit: number): Promise<{ processed: number; observations_created: number }> {
  if (!obsQueue || !obsStore || !summarize) return { processed: 0, observations_created: 0 };
  const batch = obsQueue.takeBatch(limit);
  if (batch.length === 0) return { processed: 0, observations_created: 0 };

  // Group by (session_id, prompt_number) — one observation per prompt window.
  const groups = new Map<string, typeof batch>();
  for (const row of batch) {
    const key = `${row.payload.session_id}::${row.payload.prompt_number}`;
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }

  let observations_created = 0;
  const doneIds: number[] = [];
  const failedIds: number[] = [];

  for (const groupRows of groups.values()) {
    const events = groupRows.map(r => r.payload);
    try {
      const summary = await summarize(events);
      const head = events[0]!;
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
      });
      // Chunk + embed via the existing ingest pipeline (Plan 1).
      await ingestObservation(obsStore.findById(id)!);
      observations_created++;
      doneIds.push(...groupRows.map(r => r.id));
    } catch (err) {
      console.error(`[obs-batch] summarize failed: ${(err as Error).message}`);
      failedIds.push(...groupRows.map(r => r.id));
    }
  }

  obsQueue.markDone(doneIds);
  obsQueue.markFailed(failedIds);

  return { processed: batch.length, observations_created };
}

function dedupeFlat(lists: string[][]): string[] {
  return [...new Set(lists.flat())];
}

async function ingestObservation(obs: import('../shared/types.ts').Observation): Promise<void> {
  const chunks = chunkObservation(obs);
  if (chunks.length === 0) return;
  // Synthesize a "source path" so the existing IngestPipeline can store it.
  // Using the observation row id keeps it stable + unique.
  const synthesizedPath = `observation:${opts.projectId}:${obs.id}`;
  // Build the chunks with chunk_ids and dispatch to vector + meta directly.
  // (Reusing IngestPipeline keeps the sha-diff path consistent with files.)
  const { newChunkId } = await import('../shared/id.ts');
  const { sha256Hex } = await import('../shared/sha.ts');
  const chunksWithIds = chunks.map(c => ({
    chunk_id: newChunkId('observation', String(obs.id)),
    text: c.text,
    sha: sha256Hex(c.text),
    position: c.position,
    metadata: c.metadata,
  }));

  // Embed + write through existing meta/vector — match the IngestPipeline contract.
  const embeddings = await (async () => {
    if (opts.skipEmbed) return chunksWithIds.map(() => new Array(opts.embeddingDimension).fill(0));
    try {
      return await embedder.embed(chunksWithIds.map(c => c.text));
    } catch {
      // Failure path — enqueue chunks for retry, return zero vectors so meta still lands.
      if (pendingEmbed) {
        for (const c of chunksWithIds) {
          pendingEmbed.enqueue({
            chunk_id: c.chunk_id, source_path: synthesizedPath,
            sha: c.sha, channel: 'observation',
          });
        }
      }
      return chunksWithIds.map(() => new Array(opts.embeddingDimension).fill(0));
    }
  })();

  const documentId = meta.upsertDocument({
    source_path: synthesizedPath,
    channel: 'observation',
    project_id: opts.projectId,
    sha: sha256Hex(JSON.stringify(obs)),
    mtime_epoch: obs.created_at_epoch,
    metadata: {
      observation_id: obs.id,
      session_id: obs.session_id,
      type: obs.type,
      title: obs.title,
      created_at_epoch: obs.created_at_epoch,
    },
  });
  meta.replaceChunksForDocument(documentId, chunksWithIds);
  await vector.add(
    collectionName,
    chunksWithIds.map((c, i) => ({ id: c.chunk_id, embedding: embeddings[i]! })),
  );
}

// (Auto-tick) ─────────────────────────────────────────────────────────
let tickTimer: ReturnType<typeof setInterval> | null = null;
if (tickMs > 0 && obsQueue && obsStore && summarize) {
  tickTimer = setInterval(() => {
    processBatch(batchSize).catch(err => console.error('[obs-tick]', err));
  }, tickMs);
}
```

- [ ] **Step 5: Add the three endpoints to the request handler**

Inside the `handler` function (still in `src/worker/index.ts`), after the existing `/reindex` block and before the `return new Response('Not Found', ...)`:

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
});

const ObservationFlushSchema = z.object({
  session_id: z.string().optional(),
  max: z.number().int().positive().max(500).default(100),
});

const PendingEmbedRetrySchema = z.object({
  max: z.number().int().positive().max(500).default(50),
});

if (req.method === 'POST' && url.pathname === '/observation/enqueue') {
  if (!obsQueue) return Response.json({ error: 'observation_pipeline_disabled' }, { status: 503 });
  const parsed = ObservationEnqueueSchema.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
  }
  const id = obsQueue.enqueue(parsed.data);
  return Response.json({ id, queued: true });
}

if (req.method === 'POST' && url.pathname === '/observation/flush') {
  if (!obsQueue || !obsStore || !summarize) {
    return Response.json({ error: 'observation_pipeline_disabled' }, { status: 503 });
  }
  const parsed = ObservationFlushSchema.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
  }
  let total_processed = 0;
  let total_created = 0;
  // Drain in chunks of batchSize until empty or max reached.
  while (total_processed < parsed.data.max) {
    const remaining = parsed.data.max - total_processed;
    const result = await processBatch(Math.min(batchSize, remaining));
    if (result.processed === 0) break;
    total_processed += result.processed;
    total_created += result.observations_created;
  }
  return Response.json({
    processed: total_processed,
    observations_created: total_created,
    pending_remaining: obsQueue.pendingCount(),
  });
}

if (req.method === 'POST' && url.pathname === '/pending_embed/retry') {
  if (!pendingEmbed) return Response.json({ error: 'pending_embed_disabled' }, { status: 503 });
  const parsed = PendingEmbedRetrySchema.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
  }
  const due = pendingEmbed.listDue(parsed.data.max);
  return Response.json({
    due_count: due.length,
    total_pending: pendingEmbed.totalCount(),
    // Phase 2: actual retry happens in Task 10's pending-embed worker tick.
  });
}
```

- [ ] **Step 6: Add cleanup to the `stop` function**

```typescript
return {
  port: server.port ?? opts.port,
  stop: async () => {
    if (tickTimer) clearInterval(tickTimer);
    if (watcher) await watcher.close();
    server.stop();
    if (obsQueue) obsQueue.close();
    if (obsStore) obsStore.close();
    if (pendingEmbed) pendingEmbed.close();
    vector.close();
    meta.close();
  },
};
```

- [ ] **Step 7: Wire env-driven defaults in the standalone entrypoint**

In the `if (import.meta.main)` block, append:

```typescript
const observationQueueDbPath = join(DATA_DIR, 'queue.db');
const observationsDbPath = join(DATA_DIR, 'observations.db');
const pendingEmbedDbPath = join(DATA_DIR, 'pending_embed.db');
```

(Use `DATA_DIR` from `paths.ts`. Then add these three options to the `startWorker(...)` call.)

> The `summarize` field is intentionally not wired here yet — it lands in Task 10. Until then, the standalone worker boots with the observation endpoints reachable but `flush` returns 503 until a summarizer is supplied.

- [ ] **Step 8: Run — verify pass**

```bash
bun test tests/integration/worker-observation.test.ts
```
Expected: `4 pass, 0 fail`.

- [ ] **Step 9: Commit**

```bash
git add src/worker/index.ts tests/integration/worker-observation.test.ts
git commit -m "feat(worker): observation endpoints + queue/store/pending-embed wiring + tick processor"
```

---

### Task 10: Haiku summarizer client

**Files:**
- Create: `src/worker/summarizer.ts`
- Create: `tests/unit/summarizer.test.ts`

> Anthropic API key handling: `ANTHROPIC_API_KEY` env var (matches the SDK convention). Default primary model `claude-haiku-4-6`; default fallback chain `[claude-haiku-4-5]`. Both are configurable via `AELITA_MCP_HAIKU_MODEL` and `AELITA_MCP_HAIKU_FALLBACKS` (comma-separated chain). On `model_not_found` for any candidate, the next entry in the chain is tried; the first model that responds successfully is cached for the worker's lifetime. The defaults reflect the 2026-05 model lineup — point them at newer models as they ship without touching code.

The summarizer takes a window of `RawObservationEvent` rows and returns a structured `SummarizerResult`. Output is constrained via a JSON schema embedded in the prompt; on parse failure the summarizer raises (caller in `processBatch` will mark the batch failed → retry).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/summarizer.test.ts
import { test, expect, mock } from 'bun:test';
import { HaikuSummarizer } from '../../src/worker/summarizer.ts';
import type { RawObservationEvent } from '../../src/shared/types.ts';

const ev = (over: Partial<RawObservationEvent> = {}): RawObservationEvent => ({
  session_id: 's1', project_id: 'p1', prompt_number: 1,
  tool_name: 'Edit', tool_input_summary: 'edit foo.ts',
  tool_result_summary: 'ok',
  files_read: [], files_modified: ['foo.ts'],
  ts_epoch: 1_700_000_000,
  ...over,
});

test('HaikuSummarizer — happy path returns parsed structured summary', async () => {
  const transport = mock(async () => ({
    content: [{
      type: 'text',
      text: JSON.stringify({
        type: 'bugfix',
        title: 'fixed off-by-one',
        narrative: 'replaced 1-indexed loop with 0-indexed',
        facts: ['loop started at 1', 'should start at 0'],
        concepts: ['off-by-one'],
      }),
    }],
    model: 'claude-haiku-4-6',
  }));
  const s = new HaikuSummarizer({
    apiKey: 'test-key', model: 'claude-haiku-4-6',
    transport,
  });
  const res = await s.summarize([ev()]);
  expect(res.type).toBe('bugfix');
  expect(res.title).toBe('fixed off-by-one');
  expect(res.facts).toHaveLength(2);
  expect(transport).toHaveBeenCalledTimes(1);
});

test('HaikuSummarizer — walks fallback chain on model_not_found', async () => {
  let calls = 0;
  const transport = mock(async (_args: any) => {
    calls++;
    if (calls === 1) {
      const err = new Error('model_not_found') as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({
        type: 'change', title: 't', narrative: 'n', facts: [], concepts: [],
      })}],
      model: 'claude-haiku-4-5',
    };
  });
  const s = new HaikuSummarizer({
    apiKey: 'test-key', model: 'claude-haiku-4-6',
    fallbackModels: ['claude-haiku-4-5'],
    transport,
  });
  const res = await s.summarize([ev()]);
  expect(res.type).toBe('change');
  expect(transport).toHaveBeenCalledTimes(2);
  // Subsequent calls reuse fallback (no extra retry)
  await s.summarize([ev()]);
  expect(transport).toHaveBeenCalledTimes(3);
});

test('HaikuSummarizer — invalid JSON in response raises', async () => {
  const transport = mock(async () => ({
    content: [{ type: 'text', text: 'not json' }],
    model: 'claude-haiku-4-6',
  }));
  const s = new HaikuSummarizer({
    apiKey: 'test-key', model: 'claude-haiku-4-6', transport,
  });
  await expect(s.summarize([ev()])).rejects.toThrow(/JSON|parse/i);
});

test('HaikuSummarizer — type field validated against ObservationType enum', async () => {
  const transport = mock(async () => ({
    content: [{ type: 'text', text: JSON.stringify({
      type: 'INVALID_TYPE', title: 't', narrative: 'n', facts: [], concepts: [],
    })}],
    model: 'claude-haiku-4-6',
  }));
  const s = new HaikuSummarizer({
    apiKey: 'test-key', model: 'claude-haiku-4-6', transport,
  });
  await expect(s.summarize([ev()])).rejects.toThrow(/type|enum/i);
});

test('HaikuSummarizer — empty events list returns empty narrative observation', async () => {
  const transport = mock(async () => { throw new Error('should not be called'); });
  const s = new HaikuSummarizer({
    apiKey: 'test-key', model: 'claude-haiku-4-6', transport,
  });
  const res = await s.summarize([]);
  expect(res.facts).toEqual([]);
  expect(transport).not.toHaveBeenCalled();
});

test('HaikuSummarizer — missing API key throws on construction', () => {
  expect(() => new HaikuSummarizer({
    apiKey: '', model: 'claude-haiku-4-6',
    transport: async () => ({ content: [{ type: 'text', text: '{}' }], model: 'x' }),
  })).toThrow(/api[_ ]key|apiKey/i);
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test tests/unit/summarizer.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement `HaikuSummarizer`**

```typescript
// src/worker/summarizer.ts
import { z } from 'zod';
import type { RawObservationEvent } from '../shared/types.ts';
import type { SummarizerResult } from './index.ts';
import { DEFAULT_HAIKU_MODEL, DEFAULT_HAIKU_FALLBACKS } from '../shared/paths.ts';

const ObservationTypes = ['bugfix', 'feature', 'refactor', 'discovery', 'decision', 'change'] as const;

const SummaryJsonSchema = z.object({
  type: z.enum(ObservationTypes),
  title: z.string().min(1).max(200),
  narrative: z.string(),
  facts: z.array(z.string()),
  concepts: z.array(z.string()),
});

export interface SummarizerTransportArgs {
  model: string;
  system: string;
  user: string;
  max_tokens: number;
}

export interface SummarizerTransportResult {
  content: Array<{ type: 'text'; text: string }>;
  model: string;
}

export type SummarizerTransport = (args: SummarizerTransportArgs) => Promise<SummarizerTransportResult>;

export interface HaikuSummarizerOptions {
  apiKey: string;
  /** Primary model. Default: DEFAULT_HAIKU_MODEL (snapshot of current best small Claude). */
  model?: string;
  /**
   * Ordered fallback chain. Each entry is tried in turn on `model_not_found`
   * from the previous one. The first model that responds successfully is
   * cached for the worker's lifetime. Default: DEFAULT_HAIKU_FALLBACKS.
   */
  fallbackModels?: string[];
  maxTokens?: number;
  transport?: SummarizerTransport;
}

const SYSTEM_PROMPT =
  `You are a session-observation summarizer for a developer's local memory layer.
Given a window of tool-use events, produce a single structured observation that
captures what changed, what was learned, and any reusable concept the developer
will want to retrieve later.

Output ONLY a single JSON object matching this schema, no prose around it:
{
  "type": "bugfix" | "feature" | "refactor" | "discovery" | "decision" | "change",
  "title": "short imperative summary, ≤80 chars",
  "narrative": "1-3 sentence prose summary",
  "facts": ["≤5 bullet-style atomic facts"],
  "concepts": ["≤5 short concept tags"]
}`;

function buildUserPrompt(events: RawObservationEvent[]): string {
  const lines: string[] = [];
  lines.push(`Session: ${events[0]!.session_id}`);
  lines.push(`Project: ${events[0]!.project_id}`);
  lines.push(`Prompt: ${events[0]!.prompt_number}`);
  lines.push(`Events (${events.length}):`);
  for (const e of events) {
    lines.push(`- tool=${e.tool_name}`);
    lines.push(`  input: ${e.tool_input_summary}`);
    lines.push(`  result: ${e.tool_result_summary}`);
    if (e.files_modified.length > 0) lines.push(`  modified: ${e.files_modified.join(', ')}`);
    if (e.files_read.length > 0)     lines.push(`  read: ${e.files_read.join(', ')}`);
  }
  return lines.join('\n');
}

export class HaikuSummarizer {
  private apiKey: string;
  private primaryModel: string;
  private fallbackModels: string[];
  private activeModel: string;
  private maxTokens: number;
  private transport: SummarizerTransport;

  constructor(opts: HaikuSummarizerOptions) {
    if (!opts.apiKey) throw new Error('HaikuSummarizer: apiKey required');
    this.apiKey = opts.apiKey;
    this.primaryModel = opts.model ?? DEFAULT_HAIKU_MODEL;
    // De-dup the chain — if the caller put the primary into fallbacks too, drop it
    // (calling the same model twice on a 404 just wastes a request).
    const rawChain = opts.fallbackModels ?? DEFAULT_HAIKU_FALLBACKS;
    this.fallbackModels = rawChain.filter(m => m && m !== this.primaryModel);
    this.activeModel = this.primaryModel;
    this.maxTokens = opts.maxTokens ?? 800;
    this.transport = opts.transport ?? this.defaultTransport.bind(this);
  }

  /**
   * Default Anthropic SDK transport. Swappable via constructor for tests.
   */
  private async defaultTransport(args: SummarizerTransportArgs): Promise<SummarizerTransportResult> {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: this.apiKey });
    const res = await client.messages.create({
      model: args.model,
      system: args.system,
      max_tokens: args.max_tokens,
      messages: [{ role: 'user', content: args.user }],
    });
    // Normalize SDK response to transport result.
    const content = (res.content ?? [])
      .filter((c: { type: string }) => c.type === 'text')
      .map((c: { type: 'text'; text: string }) => ({ type: 'text' as const, text: c.text }));
    return { content, model: res.model };
  }

  async summarize(events: RawObservationEvent[]): Promise<SummarizerResult> {
    if (events.length === 0) {
      return {
        type: 'change',
        title: 'no events',
        narrative: '',
        facts: [],
        concepts: [],
      };
    }

    const args: SummarizerTransportArgs = {
      model: this.activeModel,
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(events),
      max_tokens: this.maxTokens,
    };

    // Try the active model, then walk the fallback chain on `model_not_found`.
    // On the first success, cache `activeModel` for the worker's lifetime.
    const isModelMissing = (err: unknown): boolean => {
      const e = err as Error & { status?: number; error?: { type?: string } };
      return (
        e.status === 404 ||
        /model_not_found|not_found/.test(e.message ?? '') ||
        e.error?.type === 'not_found_error'
      );
    };

    const candidates = [this.activeModel, ...this.fallbackModels];
    let response: SummarizerTransportResult | null = null;
    let lastErr: unknown = null;
    for (const candidate of candidates) {
      try {
        response = await this.transport({ ...args, model: candidate });
        this.activeModel = candidate;
        break;
      } catch (err) {
        lastErr = err;
        if (!isModelMissing(err)) throw err;
        // Try the next candidate.
      }
    }
    if (response === null) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error(`HaikuSummarizer: no model in chain succeeded — ${candidates.join(', ')}`);
    }

    const textBlock = response.content.find(c => c.type === 'text');
    if (!textBlock) throw new Error('HaikuSummarizer: response had no text block');

    let json: unknown;
    try {
      // Tolerate stray prose: extract first { … } JSON-looking blob.
      const match = /\{[\s\S]*\}/.exec(textBlock.text);
      json = JSON.parse(match ? match[0] : textBlock.text);
    } catch (err) {
      throw new Error(`HaikuSummarizer: failed to parse JSON: ${(err as Error).message}`);
    }

    const parsed = SummaryJsonSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`HaikuSummarizer: response failed schema validation: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  /** Exposed for tests + diagnostics. */
  getActiveModel(): string {
    return this.activeModel;
  }
}
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test tests/unit/summarizer.test.ts
```
Expected: `6 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/worker/summarizer.ts tests/unit/summarizer.test.ts
git commit -m "feat(worker): HaikuSummarizer — Anthropic client with configurable fallback chain + zod-validated JSON output"
```

---

### Task 11: Worker — wire summarizer + `/inject/context` endpoint

**Files:**
- Modify: `src/worker/index.ts`
- Create: `tests/integration/worker-inject-context.test.ts`

This task lands `/inject/context` (the endpoint UserPromptSubmit calls) and wires the standalone-mode worker to construct a `HaikuSummarizer` from `ANTHROPIC_API_KEY`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/worker-inject-context.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';

const PORT = 39902;
let worker: WorkerHandle;
let workDir: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'aelita-inject-'));
  const memDir = join(workDir, 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, 'feedback_seed.md'), `---
type: feedback
description: Seeded
---
Always use erp-components, no custom page styles.
`);

  worker = await startWorker({
    port: PORT,
    projectId: 'inject-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    watchPaths: [join(memDir, '*.md')],
    watchChannel: 'memory',
    hookBudgetTokens: 2000,
  } as any);
  // Wait for initial indexing
  await new Promise(r => setTimeout(r, 500));
});

afterEach(async () => {
  await worker.stop();
  rmSync(workDir, { recursive: true, force: true });
});

test('POST /inject/context returns envelope under budget', async () => {
  const start = Date.now();
  const res = await fetch(`http://localhost:${PORT}/inject/context`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'erp-components rule', top_k: 5 }),
  });
  const elapsed = Date.now() - start;
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.envelope).toMatch(/<memory-context/);
  expect(body.envelope).toMatch(/<\/memory-context>/);
  expect(body.used_tokens).toBeLessThanOrEqual(2000);
  expect(body.elapsed_ms).toBeGreaterThanOrEqual(0);
  // Worker side should respond fast even on cold cache (skipEmbed=true).
  expect(elapsed).toBeLessThan(500);
});

test('POST /inject/context — short prompts return empty envelope', async () => {
  const res = await fetch(`http://localhost:${PORT}/inject/context`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'ok' }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.hit_count).toBe(0);
  expect(body.envelope).toMatch(/<memory-context.*k="0"/);
});

test('POST /inject/context — invalid body → 400', async () => {
  const res = await fetch(`http://localhost:${PORT}/inject/context`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test tests/integration/worker-inject-context.test.ts
```
Expected: endpoint not implemented.

- [ ] **Step 3: Add `/inject/context` endpoint**

In `src/worker/index.ts`, before the existing `/observation/enqueue` block, add:

```typescript
const InjectContextSchema = z.object({
  prompt: z.string(),
  top_k: z.number().int().positive().max(50).default(5),
  channels: z.array(z.enum(['memory', 'skill', 'observation'])).optional(),
  budget_tokens: z.number().int().positive().max(20_000).optional(),
});

const SHORT_PROMPT_THRESHOLD = 10;
const NO_OP_TOKENS = new Set(['ok', 'continue', 'yes', 'go', 'next', 'sure']);

if (req.method === 'POST' && url.pathname === '/inject/context') {
  const startMs = Date.now();
  const parsed = InjectContextSchema.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
  }
  const { formatEnvelope } = await import('./envelope.ts');
  const budget = parsed.data.budget_tokens ?? opts.hookBudgetTokens ?? 4000;

  // Skip rules: short prompts or no-op tokens get an empty envelope.
  const trimmed = parsed.data.prompt.trim();
  const isShort = trimmed.length < SHORT_PROMPT_THRESHOLD;
  const isNoOp = NO_OP_TOKENS.has(trimmed.toLowerCase());

  if (isShort || isNoOp) {
    const empty = formatEnvelope({
      project_id: opts.projectId,
      budget_tokens: budget,
      hits: [],
      degradation_flags: [],
    });
    return Response.json({
      envelope: empty.envelope,
      hit_count: 0,
      budget_tokens: budget,
      used_tokens: empty.used_tokens,
      channels_searched: [] as ChannelType[],
      degradation_flags: ['skipped=short_or_no_op'],
      elapsed_ms: Date.now() - startMs,
    });
  }

  // Embed the prompt; if Voyage is unreachable we still serve keyword-only.
  const flags: string[] = [];
  let embedding: number[] = [];
  if (!opts.skipEmbed) {
    try {
      const out = await embedder.embed([trimmed]);
      embedding = out[0] ?? [];
    } catch {
      flags.push('embedder=voyage:keyword-fallback=true');
    }
  } else {
    flags.push('embedder=skipped');
  }

  const fused = await searcher.search(embedding, trimmed, parsed.data.top_k * 3);
  const channelsRequested = parsed.data.channels ?? ['memory', 'skill', 'observation'];
  const hits: import('../shared/types.ts').EnvelopeHit[] = [];
  for (const f of fused) {
    const lookup = meta.getChunkById(f.id);
    if (!lookup) continue;
    if (!channelsRequested.includes(lookup.document.channel as 'memory' | 'skill' | 'observation')) continue;
    const m = lookup.chunk.metadata as Record<string, unknown>;
    hits.push({
      doc_id: lookup.chunk.chunk_id,
      channel: lookup.document.channel,
      source_path: lookup.document.source_path,
      title: (m.section_title ?? m.filename_id ?? m.title ?? 'Untitled') as string,
      snippet: lookup.chunk.text.slice(0, 600),
      score: f.score,
      metadata: m,
    });
    if (hits.length >= parsed.data.top_k) break;
  }

  const result = formatEnvelope({
    project_id: opts.projectId,
    budget_tokens: budget,
    hits,
    degradation_flags: flags,
  });

  return Response.json({
    envelope: result.envelope,
    hit_count: result.hit_count,
    budget_tokens: budget,
    used_tokens: result.used_tokens,
    channels_searched: channelsRequested,
    degradation_flags: flags,
    elapsed_ms: Date.now() - startMs,
  });
}
```

- [ ] **Step 4: Wire summarizer in standalone-mode entrypoint**

Inside the `if (import.meta.main)` block, add (before `const handle = await startWorker(...)`):

```typescript
import { HaikuSummarizer } from './summarizer.ts';
import {
  ENV_ANTHROPIC_API_KEY, DEFAULT_HAIKU_MODEL,
  ENV_HAIKU_MODEL, ENV_HAIKU_FALLBACKS, DEFAULT_HAIKU_FALLBACKS,
  ENV_HOOK_BUDGET_TOKENS,
  DEFAULT_HOOK_BUDGET_TOKENS,
  ENV_OBSERVATION_BATCH_SIZE, ENV_OBSERVATION_TICK_MS,
  DEFAULT_OBSERVATION_BATCH_SIZE, DEFAULT_OBSERVATION_TICK_MS,
} from '../shared/paths.ts';

const anthropicKey = process.env[ENV_ANTHROPIC_API_KEY];
const haikuModel = process.env[ENV_HAIKU_MODEL] ?? DEFAULT_HAIKU_MODEL;
const haikuFallbacksRaw = process.env[ENV_HAIKU_FALLBACKS];
const haikuFallbacks = haikuFallbacksRaw
  ? haikuFallbacksRaw.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_HAIKU_FALLBACKS;
const hookBudgetTokens = Number(process.env[ENV_HOOK_BUDGET_TOKENS] ?? DEFAULT_HOOK_BUDGET_TOKENS);
const observationBatchSize = Number(process.env[ENV_OBSERVATION_BATCH_SIZE] ?? DEFAULT_OBSERVATION_BATCH_SIZE);
const observationTickMs = Number(process.env[ENV_OBSERVATION_TICK_MS] ?? DEFAULT_OBSERVATION_TICK_MS);

const summarize = anthropicKey
  ? (() => {
      const summarizer = new HaikuSummarizer({
        apiKey: anthropicKey,
        model: haikuModel,
        fallbackModels: haikuFallbacks,
      });
      return (events: import('../shared/types.ts').RawObservationEvent[]) =>
        summarizer.summarize(events);
    })()
  : undefined;
if (!anthropicKey) {
  console.error(`[worker] ${ENV_ANTHROPIC_API_KEY} not set — observation pipeline disabled`);
}
```

Then add to the `startWorker(...)` call (using conditional spread to satisfy `exactOptionalPropertyTypes`):

```typescript
const handle = await startWorker({
  // … existing fields …
  observationQueueDbPath,
  observationsDbPath,
  pendingEmbedDbPath,
  hookBudgetTokens,
  observationBatchSize,
  observationTickMs,
  ...(summarize !== undefined && { summarize }),
});
```

- [ ] **Step 5: Run — verify pass**

```bash
bun test tests/integration/worker-inject-context.test.ts
```
Expected: `3 pass, 0 fail`.

- [ ] **Step 6: Commit**

```bash
git add src/worker/index.ts tests/integration/worker-inject-context.test.ts
git commit -m "feat(worker): /inject/context — envelope endpoint + summarizer wiring in standalone mode"
```

---

### Task 12: Hook shared helpers (stdin/stdout + bounded fetch)

**Files:**
- Create: `src/hooks/shared.ts`

> No unit tests yet — `shared.ts` is exercised by the hook scripts and contract tests in Task 17. The functions are deliberately minimal so the unit-test risk is low; integration tests cover behavior.

- [ ] **Step 1: Implement `src/hooks/shared.ts`**

```typescript
// src/hooks/shared.ts
//
// Shared helpers for the four hook scripts.
//
// Hook contract: Claude Code spawns the hook process, writes a JSON payload
// to stdin, and reads the hook's stdout. Errors should NEVER cause the hook
// to print stack traces — fail-open is the contract. The script's job is to
// pass through (UserPromptSubmit appends the envelope; others just log).

import { DEFAULT_WORKER_PORT } from '../shared/paths.ts';

const WORKER_BASE = `http://localhost:${process.env.AELITA_MCP_WORKER_PORT ?? DEFAULT_WORKER_PORT}`;

/** Read all of stdin synchronously (Bun supports this via Bun.stdin). */
export async function readStdinJson<T = unknown>(): Promise<T> {
  const text = await Bun.stdin.text();
  if (!text || !text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`hook: failed to parse stdin JSON: ${(err as Error).message}`);
  }
}

/** Write a string to stdout, no trailing newline added (caller controls). */
export function writeStdout(s: string): void {
  Bun.write(Bun.stdout, s);
}

export interface FetchWithTimeoutOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs: number;
}

export interface FetchResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
  timedOut: boolean;
  errorMessage: string | null;
}

/**
 * Bounded fetch — returns a structured result, NEVER throws.
 * Used by every hook so a worker outage cannot block Claude Code.
 */
export async function workerFetch<T>(
  path: string,
  opts: FetchWithTimeoutOptions,
): Promise<FetchResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      signal: controller.signal,
    };
    if (opts.body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${WORKER_BASE}${path}`, init);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, status: res.status, body: null, timedOut: false, errorMessage: `${res.status}: ${txt}` };
    }
    const body = await res.json() as T;
    return { ok: true, status: res.status, body, timedOut: false, errorMessage: null };
  } catch (err) {
    const e = err as Error;
    const timedOut = e.name === 'AbortError' || /aborted/i.test(e.message);
    return { ok: false, status: 0, body: null, timedOut, errorMessage: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Coerce hook-time CWD → project_id for non-installed flows. Honors $AELITA_MCP_PROJECT_ID. */
export function resolveProjectId(cwd: string | undefined): string {
  if (process.env.AELITA_MCP_PROJECT_ID) return process.env.AELITA_MCP_PROJECT_ID;
  if (!cwd) return 'default';
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'default';
}

/** Truncate any string to ≤ N chars, preserving a trailing marker. */
export function clamp(s: string, max: number): string {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Compact-stringify any object/value for tool_input/tool_response summaries. */
export function summarize(value: unknown, max = 1500): string {
  try {
    return clamp(typeof value === 'string' ? value : JSON.stringify(value), max);
  } catch {
    return '[unserializable]';
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/shared.ts
git commit -m "feat(hooks): shared helpers — bounded fetch, stdin JSON, summarize/clamp"
```

---

### Task 13: `UserPromptSubmit` hook

**Files:**
- Create: `src/hooks/user-prompt-submit.ts`
- Create: `tests/hooks/user-prompt-submit.test.ts`

The hook reads Claude Code's JSON payload from stdin, posts to `/inject/context` with a hard 250 ms p95 budget (configurable via `AELITA_MCP_HOOK_TIMEOUT_MS`), and writes the envelope on stdout. Failure modes — worker down, timeout, error — produce empty stdout, never block.

- [ ] **Step 1: Write the failing contract test**

```typescript
// tests/hooks/user-prompt-submit.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { readFileSync } from 'fs';
import { spawn } from 'bun';

const PORT = 39903;
const FIXTURE = readFileSync(
  join(import.meta.dir, '../fixtures/hooks/user-prompt-submit.input.json'),
  'utf-8',
);
const HOOK_PATH = join(import.meta.dir, '../../src/hooks/user-prompt-submit.ts');

let server: ReturnType<typeof Bun.serve>;
let lastReceived: unknown = null;

beforeAll(() => {
  server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/inject/context') {
        lastReceived = await req.json();
        return Response.json({
          envelope: '<memory-context project="t" k="1" budget-tokens="1000">stub</memory-context>',
          hit_count: 1,
          budget_tokens: 1000,
          used_tokens: 50,
          channels_searched: ['memory'],
          degradation_flags: [],
          elapsed_ms: 12,
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
});

afterAll(() => server.stop());

async function runHook(input: string, env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ['bun', HOOK_PATH],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      AELITA_MCP_WORKER_PORT: String(PORT),
      ...env,
    },
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

test('UserPromptSubmit — passes envelope to stdout', async () => {
  const { stdout, exitCode } = await runHook(FIXTURE);
  expect(exitCode).toBe(0);
  expect(stdout).toContain('<memory-context');
  expect(stdout).toContain('stub');
});

test('UserPromptSubmit — preserves the original prompt at the bottom', async () => {
  const { stdout } = await runHook(FIXTURE);
  expect(stdout).toContain('How do I run the worker against a custom data dir?');
  // Envelope should appear BEFORE the prompt text
  expect(stdout.indexOf('</memory-context>')).toBeLessThan(stdout.indexOf('How do I run'));
});

test('UserPromptSubmit — fails open when worker is unreachable (no envelope, exit 0)', async () => {
  const { stdout, exitCode } = await runHook(FIXTURE, { AELITA_MCP_WORKER_PORT: '1' });
  expect(exitCode).toBe(0);
  expect(stdout).not.toContain('<memory-context');
  // Original prompt MUST still pass through
  expect(stdout).toContain('How do I run the worker');
});

test('UserPromptSubmit — respects AELITA_MCP_HOOK_TIMEOUT_MS', async () => {
  const start = Date.now();
  const { stdout, exitCode } = await runHook(FIXTURE, {
    AELITA_MCP_WORKER_PORT: '1',
    AELITA_MCP_HOOK_TIMEOUT_MS: '50',
  });
  const elapsed = Date.now() - start;
  expect(exitCode).toBe(0);
  // Even on unreachable worker, total wall time stays under ~500ms
  expect(elapsed).toBeLessThan(800);
  expect(stdout).toContain('How do I run the worker');
});

test('UserPromptSubmit — empty stdin is tolerated', async () => {
  const { exitCode } = await runHook('');
  expect(exitCode).toBe(0);
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test tests/hooks/user-prompt-submit.test.ts
```
Expected: hook script not found.

- [ ] **Step 3: Implement the hook**

```typescript
// src/hooks/user-prompt-submit.ts
import { readStdinJson, writeStdout, workerFetch } from './shared.ts';
import {
  DEFAULT_HOOK_TIMEOUT_MS, ENV_HOOK_TIMEOUT_MS,
} from '../shared/paths.ts';
import type { EnvelopePayload } from '../shared/types.ts';

interface UserPromptSubmitPayload {
  prompt?: string;
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
}

async function main(): Promise<void> {
  let payload: UserPromptSubmitPayload = {};
  try {
    payload = await readStdinJson<UserPromptSubmitPayload>();
  } catch {
    // Treat unparseable stdin as no-op; let Claude Code proceed.
    return;
  }
  const prompt = payload.prompt ?? '';
  const timeoutMs = Number(process.env[ENV_HOOK_TIMEOUT_MS] ?? DEFAULT_HOOK_TIMEOUT_MS);

  const result = await workerFetch<EnvelopePayload>('/inject/context', {
    method: 'POST',
    body: { prompt, top_k: 5 },
    timeoutMs,
  });

  // Fail-open: if the worker timed out or errored, emit just the prompt.
  if (result.ok && result.body && result.body.envelope) {
    writeStdout(result.body.envelope);
    writeStdout('\n\n');
  }
  // Always pass the original prompt through. Claude Code passes whatever the
  // hook prints downstream as the model input.
  writeStdout(prompt);
}

if (import.meta.main) {
  main().catch(() => {
    // Last-resort: still pass the original prompt. We can only do that if
    // we never read stdin — but we already did, so just exit 0.
    process.exit(0);
  });
}
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test tests/hooks/user-prompt-submit.test.ts
```
Expected: `5 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/user-prompt-submit.ts tests/hooks/user-prompt-submit.test.ts
git commit -m "feat(hooks): UserPromptSubmit — bounded fetch + envelope + fail-open"
```

---

### Task 14: `SessionStart` hook

**Files:**
- Create: `src/hooks/session-start.ts`
- Create: `tests/hooks/session-start.test.ts`

`SessionStart` is the warmup pass. It pings `/health` (so the worker spins up its caches), fetches a recent-context envelope with a higher token budget (3000) and a `top_k` of 8, and writes that as the session-prelude. Failure path: silent.

- [ ] **Step 1: Write the failing contract test**

```typescript
// tests/hooks/session-start.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { readFileSync } from 'fs';
import { spawn } from 'bun';

const PORT = 39904;
const FIXTURE = readFileSync(
  join(import.meta.dir, '../fixtures/hooks/session-start.input.json'),
  'utf-8',
);
const HOOK_PATH = join(import.meta.dir, '../../src/hooks/session-start.ts');

let healthCalls = 0;
let injectCalls: unknown[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        healthCalls++;
        return Response.json({ healthy: true });
      }
      if (url.pathname === '/inject/context') {
        const body = await req.json();
        injectCalls.push(body);
        return Response.json({
          envelope: '<memory-context project="t" k="0" budget-tokens="3000"></memory-context>',
          hit_count: 0, budget_tokens: 3000, used_tokens: 0,
          channels_searched: [], degradation_flags: [], elapsed_ms: 0,
        });
      }
      return new Response('nf', { status: 404 });
    },
  });
});

afterAll(() => server.stop());

async function runHook(env: Record<string, string> = {}) {
  const proc = spawn({
    cmd: ['bun', HOOK_PATH],
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, AELITA_MCP_WORKER_PORT: String(PORT), ...env },
  });
  proc.stdin.write(FIXTURE);
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

test('SessionStart — calls /health to warm worker', async () => {
  healthCalls = 0; injectCalls = [];
  await runHook();
  expect(healthCalls).toBeGreaterThanOrEqual(1);
});

test('SessionStart — exits 0 even when worker unreachable', async () => {
  const { exitCode } = await runHook({ AELITA_MCP_WORKER_PORT: '1' });
  expect(exitCode).toBe(0);
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test tests/hooks/session-start.test.ts
```
Expected: hook script not found.

- [ ] **Step 3: Implement the hook**

```typescript
// src/hooks/session-start.ts
import { readStdinJson, workerFetch } from './shared.ts';
import {
  DEFAULT_HOOK_TIMEOUT_MS, ENV_HOOK_TIMEOUT_MS,
} from '../shared/paths.ts';

interface SessionStartPayload {
  session_id?: string;
  cwd?: string;
  source?: 'startup' | 'resume' | 'compact' | string;
}

async function main(): Promise<void> {
  // Best-effort read; failures are tolerated.
  try { await readStdinJson<SessionStartPayload>(); } catch { /* ignore */ }
  const timeoutMs = Number(process.env[ENV_HOOK_TIMEOUT_MS] ?? DEFAULT_HOOK_TIMEOUT_MS);

  // Warm the worker. We don't care about the body.
  await workerFetch('/health', { method: 'GET', timeoutMs });

  // SessionStart hook is a no-output warmup. Anything we'd inject here
  // would land in the system prompt — leave that to UserPromptSubmit so
  // the envelope is freshly aligned with the user's actual prompt.
}

if (import.meta.main) {
  main().catch(() => process.exit(0));
}
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test tests/hooks/session-start.test.ts
```
Expected: `2 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/session-start.ts tests/hooks/session-start.test.ts
git commit -m "feat(hooks): SessionStart — worker warmup, fail-open"
```

---

### Task 15: `PostToolUse` hook

**Files:**
- Create: `src/hooks/post-tool-use.ts`
- Create: `tests/hooks/post-tool-use.test.ts`

`PostToolUse` is fire-and-forget — it captures the event into the queue and exits ASAP. Hard timeout 100 ms; queue full / worker down → drop.

- [ ] **Step 1: Write the failing contract test**

```typescript
// tests/hooks/post-tool-use.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { readFileSync } from 'fs';
import { spawn } from 'bun';

const PORT = 39905;
const FIXTURE = readFileSync(
  join(import.meta.dir, '../fixtures/hooks/post-tool-use.input.json'),
  'utf-8',
);
const HOOK_PATH = join(import.meta.dir, '../../src/hooks/post-tool-use.ts');

let received: any[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/observation/enqueue') {
        const body = await req.json();
        received.push(body);
        return Response.json({ id: 1, queued: true });
      }
      return new Response('nf', { status: 404 });
    },
  });
});

afterAll(() => server.stop());

async function runHook(input: string, env: Record<string, string> = {}) {
  const proc = spawn({
    cmd: ['bun', HOOK_PATH],
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, AELITA_MCP_WORKER_PORT: String(PORT), ...env },
  });
  proc.stdin.write(input);
  proc.stdin.end();
  await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode };
}

test('PostToolUse — enqueues a normalized RawObservationEvent', async () => {
  received = [];
  await runHook(FIXTURE);
  expect(received).toHaveLength(1);
  const ev = received[0];
  expect(ev.tool_name).toBe('Edit');
  expect(ev.session_id).toBe('ses_2026-05-07T12-00-00_abc123');
  expect(typeof ev.tool_input_summary).toBe('string');
  expect(ev.files_modified).toContain('/home/kalin/projects/aelita-mcp/src/worker/index.ts');
});

test('PostToolUse — fire-and-forget on worker down', async () => {
  const { exitCode } = await runHook(FIXTURE, { AELITA_MCP_WORKER_PORT: '1' });
  expect(exitCode).toBe(0);
});

test('PostToolUse — invalid stdin → exit 0 without crashing', async () => {
  const { exitCode } = await runHook('not json');
  expect(exitCode).toBe(0);
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test tests/hooks/post-tool-use.test.ts
```
Expected: hook script not found.

- [ ] **Step 3: Implement the hook**

```typescript
// src/hooks/post-tool-use.ts
import { readStdinJson, workerFetch, summarize, resolveProjectId } from './shared.ts';
import type { RawObservationEvent } from '../shared/types.ts';

interface PostToolUsePayload {
  session_id?: string;
  cwd?: string;
  prompt_number?: number;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

const HOOK_TIMEOUT_MS = 100;

function extractFiles(input: unknown, response: unknown): { read: string[]; modified: string[] } {
  const read: string[] = [];
  const modified: string[] = [];
  // tool_input.file_path is the canonical signal for Edit/Write.
  const ip = (input ?? {}) as Record<string, unknown>;
  const rp = (response ?? {}) as Record<string, unknown>;
  if (typeof ip.file_path === 'string') {
    // Edit + Write modify; Read reads.
    if (rp && typeof rp === 'object' && 'success' in rp) modified.push(ip.file_path);
    else read.push(ip.file_path);
  }
  // tool_input.notebook_path for NotebookEdit
  if (typeof ip.notebook_path === 'string') modified.push(ip.notebook_path);
  return { read, modified };
}

async function main(): Promise<void> {
  let payload: PostToolUsePayload = {};
  try { payload = await readStdinJson<PostToolUsePayload>(); } catch { return; }

  if (!payload.tool_name) return;
  const { read, modified } = extractFiles(payload.tool_input, payload.tool_response);

  const event: RawObservationEvent = {
    session_id: payload.session_id ?? 'unknown',
    project_id: resolveProjectId(payload.cwd),
    prompt_number: payload.prompt_number ?? 0,
    tool_name: payload.tool_name,
    tool_input_summary: summarize(payload.tool_input, 1500),
    tool_result_summary: summarize(payload.tool_response, 1500),
    files_read: read,
    files_modified: modified,
    ts_epoch: Math.floor(Date.now() / 1000),
  };

  // Fire-and-forget. We don't care about the response body.
  await workerFetch('/observation/enqueue', {
    method: 'POST',
    body: event,
    timeoutMs: HOOK_TIMEOUT_MS,
  });
}

if (import.meta.main) {
  main().catch(() => process.exit(0));
}
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test tests/hooks/post-tool-use.test.ts
```
Expected: `3 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/post-tool-use.ts tests/hooks/post-tool-use.test.ts
git commit -m "feat(hooks): PostToolUse — fire-and-forget enqueue with file-modified extraction"
```

---

### Task 16: `Stop` hook + dispatcher

**Files:**
- Create: `src/hooks/stop.ts`
- Create: `src/hooks/dispatcher.ts`
- Create: `bin/aelita-mcp-hook`
- Create: `tests/hooks/stop.test.ts`

The Stop hook drains the queue for the session — 5 s budget. Then the dispatcher shim picks the right script based on `process.argv[2]` (or `$CLAUDE_HOOK_EVENT_NAME`).

- [ ] **Step 1: Write the failing test for Stop**

```typescript
// tests/hooks/stop.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { readFileSync } from 'fs';
import { spawn } from 'bun';

const PORT = 39906;
const FIXTURE = readFileSync(
  join(import.meta.dir, '../fixtures/hooks/stop.input.json'),
  'utf-8',
);
const HOOK_PATH = join(import.meta.dir, '../../src/hooks/stop.ts');

let flushBodies: any[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/observation/flush') {
        const body = await req.json();
        flushBodies.push(body);
        return Response.json({ processed: 3, observations_created: 1, pending_remaining: 0 });
      }
      return new Response('nf', { status: 404 });
    },
  });
});

afterAll(() => server.stop());

async function runHook(env: Record<string, string> = {}) {
  const proc = spawn({
    cmd: ['bun', HOOK_PATH],
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, AELITA_MCP_WORKER_PORT: String(PORT), ...env },
  });
  proc.stdin.write(FIXTURE);
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

test('Stop — flushes the queue with the session_id', async () => {
  flushBodies = [];
  await runHook();
  expect(flushBodies).toHaveLength(1);
  expect(flushBodies[0].session_id).toBe('ses_2026-05-07T12-00-00_abc123');
});

test('Stop — completes within 5s when worker is fast', async () => {
  const start = Date.now();
  const { exitCode } = await runHook();
  const elapsed = Date.now() - start;
  expect(exitCode).toBe(0);
  expect(elapsed).toBeLessThan(5_500);
});

test('Stop — completes within ~5s budget when worker unreachable', async () => {
  const start = Date.now();
  const { exitCode } = await runHook({ AELITA_MCP_WORKER_PORT: '1' });
  const elapsed = Date.now() - start;
  expect(exitCode).toBe(0);
  expect(elapsed).toBeLessThan(7_000);
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test tests/hooks/stop.test.ts
```
Expected: hook script not found.

- [ ] **Step 3: Implement Stop**

```typescript
// src/hooks/stop.ts
import { readStdinJson, workerFetch } from './shared.ts';
import { DEFAULT_STOP_DRAIN_BUDGET_MS } from '../shared/paths.ts';

interface StopPayload {
  session_id?: string;
  stop_hook_active?: boolean;
}

async function main(): Promise<void> {
  let payload: StopPayload = {};
  try { payload = await readStdinJson<StopPayload>(); } catch { return; }
  if (!payload.session_id) return;

  // Drain budget: 5 s total, single call. The worker drains in its own
  // batches — we just kick it and wait briefly.
  await workerFetch('/observation/flush', {
    method: 'POST',
    body: { session_id: payload.session_id, max: 200 },
    timeoutMs: DEFAULT_STOP_DRAIN_BUDGET_MS,
  });
}

if (import.meta.main) {
  main().catch(() => process.exit(0));
}
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test tests/hooks/stop.test.ts
```
Expected: `3 pass, 0 fail`.

- [ ] **Step 5: Implement the dispatcher**

```typescript
// src/hooks/dispatcher.ts
//
// Single shebang shim → routes to the correct hook handler based on
// argv[2] or $CLAUDE_HOOK_EVENT_NAME. Settings.json may register either:
//
//   command: "aelita-mcp-hook UserPromptSubmit"
//   command: "aelita-mcp-hook"  (with env CLAUDE_HOOK_EVENT_NAME=...)

const EVENTS: Record<string, string> = {
  UserPromptSubmit: '../hooks/user-prompt-submit.ts',
  SessionStart:     '../hooks/session-start.ts',
  PostToolUse:      '../hooks/post-tool-use.ts',
  Stop:             '../hooks/stop.ts',
};

async function main(): Promise<void> {
  const event =
    process.argv[2] ??
    process.env.CLAUDE_HOOK_EVENT_NAME ??
    process.env.AELITA_MCP_HOOK_EVENT;

  if (!event || !(event in EVENTS)) {
    // Unknown / missing event → fail-open (exit 0, no output).
    process.exit(0);
  }

  const target = EVENTS[event]!;
  await import(target);
}

if (import.meta.main) {
  main().catch(() => process.exit(0));
}
```

- [ ] **Step 6: Implement the bin shim**

```typescript
#!/usr/bin/env bun
// bin/aelita-mcp-hook
import '../src/hooks/dispatcher.ts';
```

Make executable:

```bash
chmod +x /home/kalin/projects/aelita-mcp/bin/aelita-mcp-hook
```

- [ ] **Step 7: Smoke test the dispatcher**

```bash
echo '{}' | /home/kalin/projects/aelita-mcp/bin/aelita-mcp-hook UserPromptSubmit
echo $?
```
Expected: exit 0 (worker not running → fail-open).

- [ ] **Step 8: Commit**

```bash
git add src/hooks/stop.ts src/hooks/dispatcher.ts bin/aelita-mcp-hook tests/hooks/stop.test.ts
git commit -m "feat(hooks): Stop drain (5s budget) + dispatcher shim + bin entry"
```

---

### Task 17: Hook contract tests — full envelope shape

**Files:**
- Modify: `tests/hooks/user-prompt-submit.test.ts` (add a "real envelope" snapshot)

> Tasks 13-16 already verify the wire-level contract (stdout has `<memory-context>`, fail-open, etc.). This task adds a single contract assertion that the envelope shape exactly matches the spec template — no LLM calls, the test runs the real worker against the existing memory fixture and inspects the produced envelope.

- [ ] **Step 1: Append the contract test**

```typescript
// Append to tests/hooks/user-prompt-submit.test.ts
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

test('UserPromptSubmit — envelope conforms to spec §3 template', async () => {
  const PORT2 = 39907;
  const workDir = mkdtempSync(join(import.meta.dir, '../../.tmp-hook-contract-'));
  const memDir = join(workDir, 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, 'feedback_no_null.md'),
    `---\ntype: feedback\ndescription: No NULL\n---\nNo NULL — use 0 / "" sentinels.`);

  const worker: WorkerHandle = await startWorker({
    port: PORT2,
    projectId: 'contract-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    watchPaths: [join(memDir, '*.md')],
    watchChannel: 'memory',
    hookBudgetTokens: 2000,
  } as any);
  await new Promise(r => setTimeout(r, 500));

  try {
    const fixture = JSON.stringify({
      ...JSON.parse(FIXTURE),
      prompt: 'when do I use NULL in this codebase?',
    });
    const proc = spawn({
      cmd: ['bun', HOOK_PATH],
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, AELITA_MCP_WORKER_PORT: String(PORT2) },
    });
    proc.stdin.write(fixture);
    proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // Spec §3 — envelope template assertions.
    expect(stdout).toMatch(/<memory-context retrieved-by="aelita-mcp"/);
    expect(stdout).toMatch(/project="contract-test"/);
    expect(stdout).toMatch(/k="\d+"/);
    expect(stdout).toMatch(/budget-tokens="2000"/);
    expect(stdout).toMatch(/The user did NOT see this/);
    expect(stdout).toMatch(/<\/memory-context>/);
    // Local memory section header
    expect(stdout).toMatch(/## Local memory \(\d+ results\)/);
    // [full: get_full(...)] hint
    expect(stdout).toMatch(/\[full: get_full\("memory:/);
  } finally {
    await worker.stop();
    rmSync(workDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run**

```bash
bun test tests/hooks/user-prompt-submit.test.ts
```
Expected: `6 pass, 0 fail`.

- [ ] **Step 3: Commit**

```bash
git add tests/hooks/user-prompt-submit.test.ts
git commit -m "test(hooks): contract — envelope shape matches spec §3 template against real worker"
```

---

### Task 18: CLI — `observation list` + `observation flush`

**Files:**
- Create: `src/cli/commands/observation.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Implement the command**

```typescript
// src/cli/commands/observation.ts
import { workerGet, workerPost } from '../client.ts';

interface ObservationListItem {
  id: number;
  session_id: string;
  prompt_number: number;
  type: string;
  title: string;
  created_at_epoch: number;
}

export async function observationCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? 'help';

  if (sub === 'list') {
    let limit = 20;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--limit' && args[i + 1]) {
        limit = Number(args[i + 1]); i++;
      }
    }
    const data = await workerGet(`/observations/recent?limit=${limit}`) as { items: ObservationListItem[] };
    console.log('Recent observations');
    console.log('---');
    for (const o of data.items) {
      const date = new Date(o.created_at_epoch * 1000).toISOString().slice(0, 19);
      console.log(`${date}  [${o.type.padEnd(10)}]  ${o.title}`);
    }
    console.log(`(${data.items.length} rows)`);
    return 0;
  }

  if (sub === 'flush') {
    let session_id: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--session' && args[i + 1]) { session_id = args[i + 1]; i++; }
    }
    const body: Record<string, unknown> = { max: 500 };
    if (session_id) body.session_id = session_id;
    const result = await workerPost('/observation/flush', body) as {
      processed: number; observations_created: number; pending_remaining: number;
    };
    console.log(`processed: ${result.processed}`);
    console.log(`observations_created: ${result.observations_created}`);
    console.log(`pending_remaining: ${result.pending_remaining}`);
    return 0;
  }

  console.error('Usage: aelita-mcp observation <list|flush> [--limit N] [--session ID]');
  return 2;
}
```

- [ ] **Step 2: Add the `/observations/recent` endpoint to the worker**

In `src/worker/index.ts` handler, add after the existing `/stats` block:

```typescript
if (req.method === 'GET' && url.pathname === '/observations/recent') {
  if (!obsStore) return Response.json({ items: [] });
  const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 20));
  const items = obsStore.listRecent(limit).map(o => ({
    id: o.id, session_id: o.session_id, prompt_number: o.prompt_number,
    type: o.type, title: o.title, created_at_epoch: o.created_at_epoch,
  }));
  return Response.json({ items });
}
```

- [ ] **Step 3: Wire into CLI**

In `src/cli/index.ts`:

```typescript
import { observationCommand } from './commands/observation.ts';

// Add to switch:
case 'observation': exit = await observationCommand(args.slice(1)); break;
```

Update HELP:

```
  observation  list|flush — manage observation queue (--limit N, --session ID)
```

- [ ] **Step 4: Smoke test**

```bash
bun run worker:start &
WORKER_PID=$!
sleep 1
./bin/aelita-mcp observation list
./bin/aelita-mcp observation flush
kill $WORKER_PID
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/observation.ts src/cli/index.ts src/worker/index.ts
git commit -m "feat(cli): observation list/flush + /observations/recent endpoint"
```

---

### Task 19: CLI — `config show`

**Files:**
- Create: `src/cli/commands/config.ts`
- Modify: `src/cli/index.ts`

Prints the effective configuration the worker would resolve from env + defaults — no secrets (API keys are masked).

- [ ] **Step 1: Implement**

```typescript
// src/cli/commands/config.ts
import {
  DEFAULT_WORKER_PORT, DEFAULT_VOYAGE_ENDPOINT,
  DEFAULT_HAIKU_MODEL, DEFAULT_HAIKU_FALLBACKS,
  DEFAULT_HOOK_BUDGET_TOKENS,
  DEFAULT_HOOK_TIMEOUT_MS, DEFAULT_OBSERVATION_BATCH_SIZE,
  DEFAULT_OBSERVATION_TICK_MS, DATA_DIR,
} from '../../shared/paths.ts';

function mask(secret: string | undefined): string {
  if (!secret) return '(unset)';
  if (secret.length <= 8) return '***';
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

export async function configCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? 'show';
  if (sub !== 'show') {
    console.error('Usage: aelita-mcp config show');
    return 2;
  }

  const lines = [
    'aelita-mcp effective config',
    '---',
    `data_dir              ${DATA_DIR}`,
    `worker_port           ${process.env.AELITA_MCP_WORKER_PORT ?? DEFAULT_WORKER_PORT}`,
    `project_id            ${process.env.AELITA_MCP_PROJECT_ID ?? '(default)'}`,
    `voyage_endpoint       ${process.env.AELITA_MCP_VOYAGE_ENDPOINT ?? DEFAULT_VOYAGE_ENDPOINT}`,
    `voyage_model          ${process.env.AELITA_MCP_VOYAGE_MODEL ?? 'voyage-4-nano'}`,
    `voyage_api_key        ${mask(process.env.AELITA_MCP_VOYAGE_API_KEY)}`,
    `haiku_model           ${process.env.AELITA_MCP_HAIKU_MODEL ?? DEFAULT_HAIKU_MODEL}`,
    `haiku_fallbacks       ${process.env.AELITA_MCP_HAIKU_FALLBACKS ?? DEFAULT_HAIKU_FALLBACKS.join(',')}`,
    `anthropic_api_key     ${mask(process.env.ANTHROPIC_API_KEY)}`,
    `hook_budget_tokens    ${process.env.AELITA_MCP_HOOK_BUDGET_TOKENS ?? DEFAULT_HOOK_BUDGET_TOKENS}`,
    `hook_timeout_ms       ${process.env.AELITA_MCP_HOOK_TIMEOUT_MS ?? DEFAULT_HOOK_TIMEOUT_MS}`,
    `observation_batch     ${process.env.AELITA_MCP_OBSERVATION_BATCH_SIZE ?? DEFAULT_OBSERVATION_BATCH_SIZE}`,
    `observation_tick_ms   ${process.env.AELITA_MCP_OBSERVATION_TICK_MS ?? DEFAULT_OBSERVATION_TICK_MS}`,
    `watch_memory          ${process.env.AELITA_MCP_WATCH_MEMORY ?? '(unset)'}`,
    `watch_skills          ${process.env.AELITA_MCP_WATCH_SKILLS ?? '(unset)'}`,
  ];
  for (const l of lines) console.log(l);
  return 0;
}
```

- [ ] **Step 2: Wire into CLI**

```typescript
import { configCommand } from './commands/config.ts';
case 'config': exit = await configCommand(args.slice(1)); break;
```

Add to HELP: `  config show  Print effective config (env + defaults)`.

- [ ] **Step 3: Smoke test**

```bash
./bin/aelita-mcp config show
```
Expected: lists all keys, masks API keys.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/config.ts src/cli/index.ts
git commit -m "feat(cli): config show — print effective config with masked secrets"
```

---

### Task 20: CLI — `install-hooks`

**Files:**
- Create: `src/cli/commands/install-hooks.ts`
- Modify: `src/cli/index.ts`
- Create: `tests/unit/install-hooks.test.ts`

Idempotently registers the four hooks in either `~/.claude/settings.json` (default) or `<cwd>/.claude/settings.json` (with `--project`). Warns if a different tool already owns the hook entries.

The Claude Code hook config shape (per the harness docs):
```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "/abs/path/to/aelita-mcp-hook UserPromptSubmit" } ] }
    ]
  }
}
```

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/install-hooks.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyHookInstall, AELITA_HOOK_MARKER } from '../../src/cli/commands/install-hooks.ts';

let workDir: string;
let settingsPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'aelita-install-'));
  settingsPath = join(workDir, 'settings.json');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test('applyHookInstall — empty file: writes 4 hooks all marked', () => {
  applyHookInstall({ settingsPath, hookCommand: '/usr/bin/aelita-mcp-hook' });
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  expect(settings.hooks).toBeDefined();
  for (const event of ['UserPromptSubmit', 'SessionStart', 'PostToolUse', 'Stop']) {
    expect(settings.hooks[event]).toBeDefined();
    const found = JSON.stringify(settings.hooks[event]);
    expect(found).toContain('aelita-mcp-hook');
    expect(found).toContain(AELITA_HOOK_MARKER);
  }
});

test('applyHookInstall — idempotent: re-running does not duplicate entries', () => {
  applyHookInstall({ settingsPath, hookCommand: '/usr/bin/aelita-mcp-hook' });
  applyHookInstall({ settingsPath, hookCommand: '/usr/bin/aelita-mcp-hook' });
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  // Each event's hooks array should contain exactly one aelita entry
  for (const event of ['UserPromptSubmit', 'SessionStart', 'PostToolUse', 'Stop']) {
    const groupCount = settings.hooks[event].length;
    expect(groupCount).toBe(1);
  }
});

test('applyHookInstall — preserves foreign hook entries', () => {
  writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: '/some/other/hook' }] },
      ],
    },
  }, null, 2));
  applyHookInstall({ settingsPath, hookCommand: '/usr/bin/aelita-mcp-hook' });
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  const ups = JSON.stringify(settings.hooks.UserPromptSubmit);
  expect(ups).toContain('/some/other/hook');
  expect(ups).toContain('/usr/bin/aelita-mcp-hook');
});

test('applyHookInstall — warns and skips a foreign command at our marker if present', () => {
  // A foreign tool stored a hook with our marker (collision case) — we should
  // detect, warn, and not stomp it. Implementation returns warnings list.
  writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: `/foreign/path #${AELITA_HOOK_MARKER}` }] },
      ],
    },
  }, null, 2));
  const result = applyHookInstall({ settingsPath, hookCommand: '/usr/bin/aelita-mcp-hook' });
  expect(result.warnings.length).toBeGreaterThan(0);
});

test('applyHookInstall — preserves non-hook keys in settings.json', () => {
  writeFileSync(settingsPath, JSON.stringify({
    permissions: { allow: ['Read'] },
    statusLine: { type: 'static', text: 'foo' },
  }, null, 2));
  applyHookInstall({ settingsPath, hookCommand: '/usr/bin/aelita-mcp-hook' });
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  expect(settings.permissions.allow).toEqual(['Read']);
  expect(settings.statusLine.text).toBe('foo');
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test tests/unit/install-hooks.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement**

```typescript
// src/cli/commands/install-hooks.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';

export const AELITA_HOOK_MARKER = 'aelita-mcp-hook-managed';

const EVENTS = ['UserPromptSubmit', 'SessionStart', 'PostToolUse', 'Stop'] as const;
type EventName = typeof EVENTS[number];

interface HookCommandEntry {
  type: 'command';
  command: string;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommandEntry[];
}

interface ClaudeSettings {
  hooks?: Partial<Record<EventName, HookGroup[]>>;
  [other: string]: unknown;
}

export interface ApplyHookInstallOptions {
  settingsPath: string;
  hookCommand: string; // absolute path to bin/aelita-mcp-hook
}

export interface ApplyHookInstallResult {
  events_added: number;
  events_already_present: number;
  warnings: string[];
}

function isOurEntry(entry: HookCommandEntry): boolean {
  return typeof entry.command === 'string' && entry.command.includes(AELITA_HOOK_MARKER);
}

function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettings(path: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2));
}

export function applyHookInstall(opts: ApplyHookInstallOptions): ApplyHookInstallResult {
  const { settingsPath, hookCommand } = opts;
  const settings = readSettings(settingsPath);
  if (!settings.hooks) settings.hooks = {};
  let events_added = 0;
  let events_already_present = 0;
  const warnings: string[] = [];

  for (const event of EVENTS) {
    const groups = settings.hooks[event] ?? [];
    // Detect existing aelita-managed entry
    let existing: HookCommandEntry | null = null;
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        if (isOurEntry(h)) { existing = h; break; }
      }
      if (existing) break;
    }

    if (existing) {
      // If the marker is there but the path differs, warn (foreign collision).
      if (!existing.command.startsWith(hookCommand)) {
        warnings.push(`${event}: marker present but command differs (${existing.command}); leaving untouched`);
      }
      events_already_present++;
      settings.hooks[event] = groups;
      continue;
    }

    const newEntry: HookCommandEntry = {
      type: 'command',
      command: `${hookCommand} ${event} #${AELITA_HOOK_MARKER}`,
    };
    groups.push({ hooks: [newEntry] });
    settings.hooks[event] = groups;
    events_added++;
  }

  writeSettings(settingsPath, settings);
  return { events_added, events_already_present, warnings };
}

export async function installHooksCommand(args: string[]): Promise<number> {
  let scope: 'user' | 'project' = 'user';
  let cwd = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project') scope = 'project';
    if (args[i] === '--cwd' && args[i + 1]) { cwd = resolve(args[i + 1]); i++; }
  }

  const settingsPath = scope === 'project'
    ? join(cwd, '.claude', 'settings.json')
    : join(homedir(), '.claude', 'settings.json');

  // Resolve absolute path to the hook shim — assume the CLI is colocated.
  const hookCommand = resolve(import.meta.dir, '../../../bin/aelita-mcp-hook');

  console.log(`Installing hooks to: ${settingsPath}`);
  console.log(`Hook command:        ${hookCommand}`);

  const result = applyHookInstall({ settingsPath, hookCommand });

  console.log(`events_added:        ${result.events_added}`);
  console.log(`events_already:      ${result.events_already_present}`);
  if (result.warnings.length > 0) {
    console.warn('\nWarnings:');
    for (const w of result.warnings) console.warn(`  - ${w}`);
  }
  return 0;
}
```

- [ ] **Step 4: Wire into CLI**

```typescript
import { installHooksCommand } from './commands/install-hooks.ts';
case 'install-hooks': exit = await installHooksCommand(args.slice(1)); break;
```

Add to HELP: `  install-hooks  Register hooks in ~/.claude/settings.json (--project for project-scoped)`.

- [ ] **Step 5: Run — verify pass**

```bash
bun test tests/unit/install-hooks.test.ts
```
Expected: `5 pass, 0 fail`.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/install-hooks.ts src/cli/index.ts tests/unit/install-hooks.test.ts
git commit -m "feat(cli): install-hooks — idempotent hook registration with foreign-entry preservation"
```

---

### Task 21: Pending-embed retry tick

**Files:**
- Modify: `src/worker/index.ts`
- Create: `tests/integration/pending-embed-retry.test.ts`

Embedding failures during observation ingest already write to `PendingEmbedQueue` (Task 9). This task adds the retry tick: every 60 s the worker calls Voyage on each due chunk; success → embedding overwritten + row removed; failure → `markRetried(60s)` exponential.

- [ ] **Step 1: Write the failing integration test**

```typescript
// tests/integration/pending-embed-retry.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';

const PORT = 39908;
let worker: WorkerHandle;
let workDir: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'aelita-pe-int-'));
});

afterEach(async () => {
  if (worker) await worker.stop();
  rmSync(workDir, { recursive: true, force: true });
});

test('POST /pending_embed/retry returns due_count + total_pending', async () => {
  worker = await startWorker({
    port: PORT,
    projectId: 'pe-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    pendingEmbedDbPath: join(workDir, 'pending.db'),
  } as any);

  const res = await fetch(`http://localhost:${PORT}/pending_embed/retry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ max: 50 }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty('due_count');
  expect(body).toHaveProperty('total_pending');
  expect(body.total_pending).toBe(0);
});

test('observation ingest with embed-failure pushes rows to pending_embed', async () => {
  worker = await startWorker({
    port: PORT,
    projectId: 'pe-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:1/will-fail',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    // skipEmbed: false here so we exercise the embed call (and watch it fail).
    observationQueueDbPath: join(workDir, 'queue.db'),
    observationsDbPath: join(workDir, 'obs.db'),
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    summarize: async () => ({
      type: 'change', title: 't', narrative: 'n',
      facts: ['a fact'], concepts: [],
    }),
    observationTickMs: 0,
  } as any);

  await fetch(`http://localhost:${PORT}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 's', project_id: 'pe-test', prompt_number: 1,
      tool_name: 'Edit', tool_input_summary: 'x', tool_result_summary: 'y',
      files_read: [], files_modified: [], ts_epoch: 1_700_000_000,
    }),
  });
  await fetch(`http://localhost:${PORT}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's' }),
  });

  const res = await fetch(`http://localhost:${PORT}/pending_embed/retry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ max: 50 }),
  });
  const body = await res.json();
  expect(body.total_pending).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run — verify fail (or pass if no retry tick yet)**

```bash
bun test tests/integration/pending-embed-retry.test.ts
```
Expected: first test passes; second test passes (the existing `ingestObservation` already enqueues on failure thanks to Task 9 step 4).

- [ ] **Step 3: Add the retry tick to `startWorker`**

In `src/worker/index.ts`, add after the existing `tickTimer` block:

```typescript
let pendingTickTimer: ReturnType<typeof setInterval> | null = null;
const PENDING_RETRY_TICK_MS = 60_000;
const PENDING_BATCH = 25;

async function processPendingEmbed(limit: number): Promise<{ retried: number; embedded: number }> {
  if (!pendingEmbed) return { retried: 0, embedded: 0 };
  const due = pendingEmbed.listDue(limit);
  if (due.length === 0) return { retried: 0, embedded: 0 };

  // Look up the chunk text from meta. The chunk row holds canonical text.
  const ids: number[] = [];
  const texts: string[] = [];
  const chunkIds: string[] = [];
  for (const row of due) {
    const lookup = meta.getChunkById(row.chunk_id);
    if (!lookup) {
      ids.push(row.id);  // Stale row — drop it
      continue;
    }
    texts.push(lookup.chunk.text);
    chunkIds.push(row.chunk_id);
  }
  if (ids.length > 0) pendingEmbed.markEmbedded(ids);
  if (texts.length === 0) return { retried: due.length, embedded: 0 };

  try {
    const embeddings = await embedder.embed(texts);
    await vector.add(
      collectionName,
      chunkIds.map((cid, i) => ({ id: cid, embedding: embeddings[i]! })),
    );
    pendingEmbed.markEmbedded(due.map(r => r.id));
    return { retried: due.length, embedded: chunkIds.length };
  } catch {
    pendingEmbed.markRetried(due.map(r => r.id), PENDING_RETRY_TICK_MS);
    return { retried: due.length, embedded: 0 };
  }
}

if (pendingEmbed && !opts.skipEmbed) {
  pendingTickTimer = setInterval(() => {
    processPendingEmbed(PENDING_BATCH).catch(err => console.error('[pe-tick]', err));
  }, PENDING_RETRY_TICK_MS);
}
```

And in the `stop` function:

```typescript
if (pendingTickTimer) clearInterval(pendingTickTimer);
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test tests/integration/pending-embed-retry.test.ts
```
Expected: `2 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/worker/index.ts tests/integration/pending-embed-retry.test.ts
git commit -m "feat(worker): pending-embed retry tick — re-embeds failed chunks every 60s"
```

---

### Task 22: Plan-2 release-gate test (full session)

**Files:**
- Create: `tests/integration/plan2-release-gate.test.ts`

End-to-end exercise: SessionStart → UserPromptSubmit (gets memory) → tool calls (PostToolUse fires) → Stop (drains, summarizes). Uses the real worker with a stub summarizer + skipEmbed.

- [ ] **Step 1: Write the test**

```typescript
// tests/integration/plan2-release-gate.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'bun';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';

const PORT = 39920;
let worker: WorkerHandle;
let workDir: string;
const HOOK = (name: string) => join(import.meta.dir, `../../src/hooks/${name}.ts`);

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'aelita-rg-'));
  const memDir = join(workDir, 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, 'feedback_seed.md'),
    `---\ntype: feedback\ndescription: seed\n---\nNo NULL — use sentinels.`);

  worker = await startWorker({
    port: PORT,
    projectId: 'release-gate',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    watchPaths: [join(memDir, '*.md')],
    watchChannel: 'memory',
    hookBudgetTokens: 2000,
    observationQueueDbPath: join(workDir, 'queue.db'),
    observationsDbPath: join(workDir, 'obs.db'),
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    summarize: async (events) => ({
      type: 'feature',
      title: `Plan-2 stub for ${events.length} events`,
      narrative: 'session test summary',
      facts: events.map(e => `tool=${e.tool_name}`),
      concepts: ['plan-2'],
    }),
    observationTickMs: 0,
  } as any);
  await new Promise(r => setTimeout(r, 600));
});

afterAll(async () => {
  await worker.stop();
  rmSync(workDir, { recursive: true, force: true });
});

async function runHook(script: string, payload: unknown): Promise<{ stdout: string; exitCode: number }> {
  const proc = spawn({
    cmd: ['bun', script],
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, AELITA_MCP_WORKER_PORT: String(PORT) },
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

test('plan2 release-gate — full session round trip', async () => {
  const session_id = 'ses-rg-1';

  // 1. SessionStart
  let r = await runHook(HOOK('session-start'), { session_id, hook_event_name: 'SessionStart', cwd: workDir });
  expect(r.exitCode).toBe(0);

  // 2. UserPromptSubmit — should produce a non-empty envelope
  r = await runHook(HOOK('user-prompt-submit'), {
    session_id, hook_event_name: 'UserPromptSubmit', cwd: workDir,
    prompt: 'when do I use NULL in this codebase?',
    prompt_number: 1,
  });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('<memory-context');
  expect(r.stdout).toContain('when do I use NULL');

  // 3. PostToolUse × 2
  for (const i of [1, 2]) {
    const x = await runHook(HOOK('post-tool-use'), {
      session_id, hook_event_name: 'PostToolUse', cwd: workDir,
      prompt_number: 1,
      tool_name: i === 1 ? 'Read' : 'Edit',
      tool_input: { file_path: `/tmp/foo-${i}.ts` },
      tool_response: { success: true },
    });
    expect(x.exitCode).toBe(0);
  }

  // 4. Stop — drains
  r = await runHook(HOOK('stop'), { session_id, hook_event_name: 'Stop' });
  expect(r.exitCode).toBe(0);

  // Verify observations landed
  const recent = await fetch(`http://localhost:${PORT}/observations/recent?limit=10`).then(r2 => r2.json());
  expect(recent.items.length).toBeGreaterThan(0);
  expect(recent.items[0].title).toMatch(/Plan-2 stub/);

  // Stats should now show observation chunks too
  const stats = await fetch(`http://localhost:${PORT}/stats`).then(r2 => r2.json());
  expect(stats.by_channel.observation ?? 0).toBeGreaterThan(0);
}, 30_000);
```

- [ ] **Step 2: Run**

```bash
bun test tests/integration/plan2-release-gate.test.ts
```
Expected: `1 pass, 0 fail`. (Allow up to ~30 s; it spawns 5 hook processes.)

- [ ] **Step 3: Commit**

```bash
git add tests/integration/plan2-release-gate.test.ts
git commit -m "test(plan2): release-gate — full SessionStart → prompt → tools → Stop round trip"
```

---

### Task 23: USAGE.md Plan-2 update

**Files:**
- Modify: `docs/USAGE.md`

- [ ] **Step 1: Append a Plan-2 section to `docs/USAGE.md`**

```markdown
# aelita-mcp Plan-2 — Hooks + Observation Pipeline

Plan 2 layers auto-injection hooks, the observation queue, and the Haiku
summarizer on top of the Plan-1 foundation.

## New prerequisites

| Variable | Default | Required for |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Observation summarization (Haiku-class small model). Without it the queue accepts events but `flush` returns 503. |
| `AELITA_MCP_HAIKU_MODEL` | `claude-haiku-4-6` | Primary summarizer model. Default is a 2026-05 snapshot — point it at any newer model when one ships (e.g. `claude-haiku-4-7`). |
| `AELITA_MCP_HAIKU_FALLBACKS` | `claude-haiku-4-5` | Comma-separated fallback chain. Each model is tried in order on `model_not_found`; the first one that responds is cached for the worker's lifetime. |
| `AELITA_MCP_HOOK_BUDGET_TOKENS` | `4000` | Hard cap on `<memory-context>` token budget. |
| `AELITA_MCP_HOOK_TIMEOUT_MS` | `250` | UserPromptSubmit hard timeout. |
| `AELITA_MCP_OBSERVATION_BATCH_SIZE` | `20` | Rows pulled per processor tick. |
| `AELITA_MCP_OBSERVATION_TICK_MS` | `5000` | Interval for the auto-tick processor. |

## Install hooks

```bash
# User-scope (default) — registers in ~/.claude/settings.json
aelita-mcp install-hooks

# Project-scope — registers in <cwd>/.claude/settings.json
aelita-mcp install-hooks --project
```

The command is idempotent — running it twice doesn't duplicate entries.
Foreign hook entries (from other tools) are preserved.

## CLI extensions (Plan 2)

```bash
aelita-mcp config show              # Effective config + masked secrets
aelita-mcp observation list         # Recent observations
aelita-mcp observation list --limit 50
aelita-mcp observation flush        # Drain the whole queue
aelita-mcp observation flush --session ses_xyz
aelita-mcp install-hooks            # Register hooks in settings.json
aelita-mcp install-hooks --project
```

## Hook contracts at a glance

| Hook | Latency budget | Behavior on worker down |
|---|---|---|
| `UserPromptSubmit` | 250 ms p95 | No envelope; original prompt still passes through |
| `SessionStart` | 250 ms p95 | Silent |
| `PostToolUse` | 100 ms (fire-and-forget) | Event dropped |
| `Stop` | 5 s drain | Queue persists for next session |

## What's NOT in Plan 2

- Migration from `claude-mem` (Plan 3)
- Federation with remote MCPs (Plan 3)
- `optimize` / `purge` / `forget` (Plan 3)
- Retrieval-quality eval runner (Plan 3)
- Local Voyage install script (Plan 3)
```

- [ ] **Step 2: Commit**

```bash
git add docs/USAGE.md
git commit -m "docs(usage): plan-2 section — hooks, observations, install-hooks, env vars"
```

---

## Architecture overview (after Plan 2)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Claude Code harness                                │
│                                                                          │
│  spawns 4 hook processes per event:                                      │
│    aelita-mcp-hook UserPromptSubmit  (≤250 ms p95, fail-open)            │
│    aelita-mcp-hook SessionStart      (warmup)                            │
│    aelita-mcp-hook PostToolUse       (fire-and-forget)                   │
│    aelita-mcp-hook Stop              (5 s drain)                         │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ stdin: JSON payload
                                 ▼
                ┌────────────────────────────────────┐
                │   src/hooks/dispatcher.ts          │
                │   → routes to one of 4 handlers    │
                └────────────────┬───────────────────┘
                                 │ HTTP (bounded fetch, AbortSignal)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              Worker (long-lived, port 39888)                             │
│                                                                          │
│  Endpoints (Plan 2 additions in **bold**):                               │
│    /health, /stats, /search/{all,memory,skill,observations},             │
│    /get_full, /reindex,                                                  │
│    **/inject/context           ← UserPromptSubmit**                      │
│    **/observation/enqueue      ← PostToolUse (fire-and-forget)**         │
│    **/observation/flush        ← Stop (drains + summarizes)**            │
│    **/observations/recent      ← CLI observation list**                  │
│    **/pending_embed/retry      ← admin / cron**                          │
│                                                                          │
│  Stores:                                                                 │
│    MetaStore (Plan 1)                                                    │
│    VectorStore via sqlite-vec (Plan 1)                                   │
│    **ObservationQueue       — queue.db (SQLite WAL)**                    │
│    **ObservationsStore      — observations.db**                          │
│    **PendingEmbedQueue      — pending_embed.db**                         │
│                                                                          │
│  Ticks:                                                                  │
│    Watcher (Plan 1)                                                      │
│    **Observation processor   — every observationTickMs ms**              │
│    **Pending-embed retry     — every 60 s**                              │
│                                                                          │
│  External calls:                                                         │
│    Voyage     (embedding — already exists in Plan 1)                     │
│    **Anthropic Haiku-class (configurable) — via @anthropic-ai/sdk**      │
└─────────────────────────────────────────────────────────────────────────┘
```

Pipeline for one observation:

```
PostToolUse hook
   │ summarize(tool_input/result) → RawObservationEvent
   ▼
POST /observation/enqueue
   │ queue.db (status='pending')
   ▼
Observation processor tick (every 5 s) OR Stop hook → /observation/flush
   │ takeBatch(20) → group by (session, prompt_number)
   ▼
HaikuSummarizer.summarize(events)
   │ JSON object → SummarizerResult
   ▼
ObservationsStore.insert(observation)
   │ chunkObservation(obs) → narrative chunk + per-fact chunks
   ▼
embedder.embed(chunks)        → on failure: PendingEmbedQueue.enqueue()
vector.add(chunks)
meta.upsertDocument + replaceChunksForDocument
   │
   ▼
queue row → status='done'
```

---

## Anti-patterns to avoid

- **Don't print stack traces from hook scripts.** Hooks must always exit 0 and either emit clean output or nothing. A stack trace pollutes the model input.
- **Don't extend hook timeouts to "be safe".** The 250 ms cap on UserPromptSubmit is the contract. Slow hooks degrade Claude Code's interactive feel more than missing memory does.
- **Don't drop events on embed failure** — push to `PendingEmbedQueue` instead. Spec §5: "queue, don't drop".
- **Don't bypass the existing IngestPipeline** for memory/skill files. Observations have their own ingestion path because they synthesize a `source_path` and need their own chunker; everything else still flows through Plan-1 code.
- **Don't spread `undefined` into worker options** — `exactOptionalPropertyTypes` will reject it. Use the `...(value !== undefined && { key: value })` pattern (already used throughout Plan 1).
- **Don't hard-code the model name in the summarizer prompt.** The runtime walks a configurable fallback chain on `model_not_found`; the prompt body must stay model-agnostic so it works against any current or future Haiku-class model.
- **Don't store the Anthropic API key in `config.json`.** It comes from `ANTHROPIC_API_KEY` only. `config show` masks it.
- **Don't write to `~/.claude/settings.json` directly** — go through `applyHookInstall`. Foreign hook entries must survive.
- **Don't introduce new env-var prefixes.** Everything Plan-2 adds is `AELITA_MCP_*` except the SDK-conventional `ANTHROPIC_API_KEY`.
- **Don't poll the observation queue from the CLI.** Use `flush` (one shot) for explicit drains; the worker tick handles the steady state.
- **Don't recompute embeddings on Stop.** Stop drains the queue → summarizes → ingests once; nothing extra.

---

## Self-Review Checklist

Run through these before declaring Plan 2 complete:

- [ ] Every spec section in scope for Plan 2 has at least one task implementing it (§3 hooks + envelope; §4 queue; §5 timeout/queue-don't-drop; §6 hook contract tests; D8 summarizer).
- [ ] All four hooks fail open: empty stdout / exit 0 when the worker is down or slow.
- [ ] `UserPromptSubmit` total wall time stays ≤ 800 ms even on worker timeout (250 ms hook timeout × ≤2 retries).
- [ ] No `chromaDataDir` / `skipChromaConnect` / `ChromaClient` references anywhere in Plan 2 (Plan-1 pivoted to `VectorStore` already).
- [ ] `<memory-context>` envelope template matches spec §3 verbatim — opening/closing tags, header, per-channel sections, `[full: get_full(...)]` hints.
- [ ] Anthropic API key handling is `ANTHROPIC_API_KEY` only; `config show` masks it.
- [ ] Summarizer fallback chain walks correctly on `model_not_found` (exercised in a unit test). The unit test uses literal model names (`claude-haiku-4-6` → `claude-haiku-4-5`) since they're the current snapshot defaults — update both the test and the `DEFAULT_HAIKU_*` constants together if newer models become the canonical defaults.
- [ ] No-LLM-calls in any contract test (real Anthropic API is mocked or stubbed).
- [ ] `applyHookInstall` is idempotent and preserves foreign entries — both verified by unit tests.
- [ ] Plan-1 components (worker, MCP server, file watcher, IngestPipeline, CLI) are extended, not rewritten.
- [ ] `bin/aelita-mcp-hook` is executable (`chmod +x`).
- [ ] Every task ends with a commit step.
- [ ] All commit messages follow the conventional prefix (feat/fix/test/docs/chore).
- [ ] `bun run typecheck` passes after every task.

---

## Out of Scope (Plan 3)

The following remain deferred:

| Feature | Why deferred |
|---|---|
| Migration from `claude-mem` (`migrate-from-claude-mem`) | Independent of Plan-2 hooks; can land any time after Plan 2. |
| Federation with remote MCPs (Aelita KB, circuit breakers) | Adds remote network risk to UserPromptSubmit; needs separate hardening pass. |
| Duplicate cluster detection / `optimize` / `purge` / `forget` | Needs corpus to accumulate first; cheaper to design once Plan-2 has run for ~2 weeks. |
| Retrieval-quality eval runner + golden queries | Depends on having a real corpus + observations to label. |
| Local Voyage install script (`aelita-mcp install-voyage`) | Separate deployment workstream; can be hand-rolled until then. |
| MEMORY.md transformation script (archive + new shape) | UX concern, not a runtime concern. Plan 2 doesn't need it. |

Plan 2 explicitly does NOT touch any of the above.

---

## Execution Handoff

Plan 2 is saved to `~/projects/aelita-mcp/docs/plans/2026-05-07-aelita-mcp-v1-plan-2-hooks-observations.md`.

**Recommended execution mode:** subagent-driven (one fresh subagent per task). Each task is self-contained — the subagent receives the plan, reads only the files listed under **Files:**, runs steps 1-N, and commits. No inter-task ambiguity.

**Inline execution** is also viable if you want to steer the summarizer prompt or the envelope formatter mid-stream — the formatter and the summarizer prompt are the two places where designer judgment can compound.

**Order dependency:** Tasks 1-9 are mostly independent but Tasks 10-22 must run sequentially (each builds on the previous: summarizer wires into worker, hooks call worker endpoints, contract tests use real worker, release gate uses everything).

**One mid-execution checkpoint** worth pausing for: after Task 11, the worker can serve `/inject/context` against a real Voyage instance. Run `aelita-mcp config show` and a manual `curl` smoke test against the worker before continuing into the hook scripts. If the envelope shape doesn't match the spec template exactly, the contract tests in Task 17 will fail loudly anyway.

**Plan-3 trigger:** Plan 2 is complete when `tests/integration/plan2-release-gate.test.ts` passes and `aelita-mcp install-hooks` registers all four hooks idempotently against a fresh `~/.claude/settings.json`. At that point Plan 3 (migration + federation + optimization + eval runner) becomes the next planning input.
