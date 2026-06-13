# Captain Remember — curated-memory write path + autonomous promotion

- **Status:** Draft (design approved, pending spec review)
- **Date:** 2026-06-13
- **Scope:** OSS captain core only (must keep `ci(moat)` green — no federation surface)
- **Supersedes / relates to:** observation pipeline, tide-sweep, quartermaster auto-dedup

## 1. Problem

Captain Memo can *read* curated "local memory" (the `memory` channel) but cannot *write* it.
The `memory` channel is a folder of markdown files indexed from the watch glob
`~/.claude/projects/*/memory/*.md` (`CAPTAIN_MEMO_WATCH_MEMORY`). The MCP surface
exposes only reads + `reindex`/`stats`/`status` (`src/mcp-server.ts`); `classifyRoute`
exposes only read paths (`src/worker/route-class.ts`). The only write-ish route is for
*observations* (`/observation/enqueue`), which is a different, lower-signal channel.

Consequently, to persist a curated decision/preference/fact, a human or model must
hand-author a markdown file into a watched `memory/` dir and wait for the watcher (or run
`reindex`). We want **the Captain to be the memory**: a first-class capability to persist
curated entries, used both **explicitly** (a "remember this" call) and **autonomously**
(promoting durable, high-signal observations into curated memory).

## 2. Decisions (locked during brainstorming)

1. **Both** an explicit remember capability *and* autonomous promotion, sharing **one**
   write implementation.
2. **Hybrid input contract:** caller supplies `body` + `type` (required); `name`,
   `description`, `slug` are optional overrides — the Captain generates anything missing.
3. **Write target:** the current project's `~/.claude/projects/<slug>/memory/`, created if
   missing, indexed **in-process** (not via the watcher).
4. **Dedup = update-in-place:** when a remembered entry overlaps an existing one, update
   that file rather than spawn a near-duplicate; overlap = filename/slug collision *or* a
   semantic-similarity check via the embedder.
5. **Promotion governance:** opt-in behind an env flag, then autonomous on a periodic tick,
   sourced from high-signal observations, via the shared write+dedup path.
6. **Update strategy (sub-decision A):** on update, **merge** — the summarizer folds the new
   information into the existing entry, preserving prior content; then overwrite.
7. **Promotion target (sub-decision B):** promotion writes to a configured
   `CAPTAIN_MEMO_REMEMBER_DIR`, default user-global `~/.claude/memory/` (promotion has no
   live session cwd; observations carry `project_id="default"`, not a path).

## 3. Architecture (Approach A — worker owns one primitive)

The writer engine gains a single internal primitive, `writeMemory()`. Three thin callers
feed it; nothing else duplicates the write/dedup/index logic.

```
  MCP `remember` tool ─┐
  CLI `remember` ──────┼─► POST /remember (writer engine) ─► writeMemory(input, deps)
  Promotion job ───────┘   (in-process, no HTTP)              │
                                                              ├─ resolve target dir
                                                              ├─ fill frontmatter (summarizer)
                                                              ├─ dedup / find update target (embedder)
                                                              ├─ create | merge+overwrite
                                                              ├─ ingest.indexFile(path, 'memory')
                                                              └─ return {ok, path, action, doc_id}
```

Rationale: `classifyRoute` already routes unknown POSTs to the **writer** engine
(`route-class.ts:19`), which is exactly where `IngestPipeline` (`index.ts:369`), the
`Summarizer` transport (`index.ts:~1818`), the embedder, and `MetaStore`/`VectorStore`
live. One implementation, reusing summarizer + embedder + ingest + tide, respecting the
reader/writer split. DRY by construction: explicit and autonomous paths cannot drift.

Rejected alternatives: **(B)** client-side write + `reindex` — pushes summarizer/embedder
dedup logic into every caller, breaks update-in-place and DRY. **(C)** separate
persistence daemon — breaks the single-daemon model for no benefit.

## 4. The `writeMemory()` primitive

**New module:** `src/worker/memory-writer.ts`. Pure orchestrator with **injected deps** so it
unit-tests without a live worker:

```ts
interface RememberInput {
  body: string;                 // required — the substance
  type: string;                 // required — e.g. decision|feedback|reference|preference|...
  name?: string;                // optional override
  description?: string;         // optional override
  slug?: string;                // optional override (filename stem, no prefix/ext)
  projectContext: { cwd?: string };  // resolves target dir
  sourceObservationId?: number; // provenance when promoted
  targetDirOverride?: string;   // promotion passes CAPTAIN_MEMO_REMEMBER_DIR here
}
interface WriteMemoryDeps {
  ingest: IngestPipeline;
  embed: (texts: string[]) => Promise<number[][]>;
  searchMemory: (queryEmbedding: number[], dir: string, k: number) => Promise<MemoryHit[]>;
  generate: SummarizerTransport;   // reuse model-fallback transport, NOT observation summarize()
  registerSelfWrite: (absPath: string) => void;  // suppress watcher double-process
  rememberDir: string;             // default target when no project cwd (promotion)
  dedupThreshold: number;          // CAPTAIN_MEMO_REMEMBER_DEDUP_THRESHOLD
}
type WriteMemoryResult =
  | { ok: true; path: string; action: 'created' | 'updated'; doc_id: string }
  | { ok: false; reason: string };
```

**Pipeline:**

1. **Resolve target dir** (3-way precedence): `targetDirOverride` (explicit CLI `--dir`) →
   else `projectSlugFromCwd(cwd)` → `~/.claude/projects/<slug>/memory/` when `cwd` is present
   → else `deps.rememberDir` (the configured default; this is the path the promotion job hits,
   since it has no live session cwd). `mkdir -p` the chosen dir.
   Slug = cwd with path separators encoded to match Claude Code's existing project-dir
   scheme (observed: `/home/kalin/projects/captain-memo` → `-home-kalin-projects-captain-memo`).
   **Verification item:** confirm Claude Code's exact encoding for `.`, `_`, and trailing
   slashes during implementation rather than assuming; add unit cases for each.

2. **Fill frontmatter.** If any of `name`/`description`/`slug`/`type` is missing, one
   `generate` call (reusing the `SummarizerTransport` + model-fallback chain) returns them
   via a small zod schema `{ name, description, slug, type }`. Filename = `<prefix>_<slug>.md`,
   where `prefix` maps from `type` via a small table (`feedback`→`feedback`,
   `reference`→`reference`, `decision`→`decision`, `preference`→`feedback`, … default:
   the type itself). Matches the existing `feedback_`/`project_`/`reference_`/`user_`
   convention; introduces `decision_` as needed.

3. **Dedup / find update target.**
   - (a) Filename/slug collision: if `<prefix>_<slug>.md` exists in target dir → update target.
   - (b) Semantic: `embed([body])`, query the `memory` channel scoped to the target dir;
     if top similarity ≥ `dedupThreshold` and the hit is a `memory_file` in the same dir →
     update target.
   - Else → create.

4. **Create vs update.**
   - Create: render frontmatter + body, write fresh.
   - Update (merge): read the existing file, call `generate` to fold the new info into it
     (preserving prior content), render, overwrite.

5. **Index in-process.** `registerSelfWrite(absPath)` then `ingest.indexFile(absPath, 'memory')`
   (SHA-dedup, chunking, embed, vector upsert; old chunks dropped automatically). A chokidar
   `add`/`change` that still fires is a harmless `skipped` (SHA-idempotent) and is suppressed
   by the self-write registration anyway.

6. **Return** the structured result.

**Frontmatter shape written** (matches the existing chunker `src/worker/chunkers/memory-file.ts`):
```
---
name: <title>
description: <one-line>
type: <type>
originSessionId: <if available>      # optional, mirrors existing reference_*.md files
sourceObservationId: <if promoted>   # provenance
---
<body, optionally with ## H2 sections — each becomes its own chunk>
```

## 5. Error handling — the write never blocks on the LLM

- **Summarizer down/offline** (no key/OAuth, transport throws, or model_not_found through
  the whole fallback chain): **deterministic fallback** — `name` = first non-empty line of
  body (trimmed/truncated), `description` = truncated body, `slug` = slugified name, `type`
  = caller-provided (required, so always present). The LLM only *enriches*; it is never on
  the critical path for a successful write.
- **Embedder down:** skip semantic dedup (4b); keep filename-collision dedup (4a). Log a warning.
- **Atomic write:** write to a temp file in the same dir, then `rename()` — the watcher never
  observes a half-written file.
- **Disk/permission errors:** return `{ ok: false, reason }`; caller surfaces it (MCP error,
  CLI non-zero exit, promotion log line). Never silent (v0.2.13 "no silent failures" value).

## 6. Callers (thin)

### 6.1 MCP `remember` tool (`src/mcp-server.ts`)
New tool beside `search_memory`. Input schema `{ body* , type*, name?, description?, slug? }`.
The MCP server injects `projectContext.cwd = process.cwd()` (it runs in the session's
project dir) and POSTs `/remember`. Tool description steers the model: *persist durable
decisions / preferences / facts worth recalling in future sessions — not ephemeral scratch.*
Returns `action` + `path` to the model.

### 6.2 Worker route `POST /remember` (`src/worker/index.ts`)
Zod-parse the request → build `WriteMemoryDeps` from the writer engine's existing instances
→ `writeMemory(input, deps)` → JSON result. No `route-class.ts` change required (unknown POST
→ writer). Optionally add `/remember` to a named write set for readability only.

### 6.3 CLI `captain-memo remember` (`src/cli/commands/remember.ts` + `src/cli/index.ts`)
Flags `--type`, `--name`, `--description`, `--slug`; body via `--body`, `--file`, or stdin.
Resolves cwd, POSTs `/remember`. Gives scripts and other AI tools (Codex/Cursor/Gemini CLI)
the same capability — consistent with the cross-AI positioning.

## 7. Promotion job (opt-in, autonomous)

Modeled exactly on **Quartermaster auto-dedup** (opt-in, OFF by default, sibling
`setInterval` at `index.ts:777`).

- **Gate:** `CAPTAIN_MEMO_PROMOTE_ENABLE` (default OFF). When on, a new `setInterval` sibling
  to the qm-dedup timer, interval `CAPTAIN_MEMO_PROMOTE_INTERVAL_MS`, guarded by the same
  in-flight-skip pattern (skip, not queue, if a run is in flight).
- **Candidate selection:** `obsStore.listRecent(N)` / `listByTideState('active')`, filtered to
  durable observation types (`decision`, `feature`, `discovery`) and/or recall-count ≥ k
  (importance signal), excluding already-promoted rows.
- **Judge:** one `generate` pass decides *curated-worthy vs ephemeral* and distills
  `{ type, name, description, body }` from each surviving observation. This is the
  "remember forever?" gate — most observations are NOT promoted.
- **Write:** `writeMemory()` per survivor with `sourceObservationId` provenance and **no**
  `cwd`, so target resolution falls through to `deps.rememberDir` (= `CAPTAIN_MEMO_REMEMBER_DIR`).
  Update-in-place dedup means re-runs never spawn duplicates.
- **Idempotency:** mark promoted observations (a `promoted_at` column on the observations row,
  or a small `promotions` table — mirroring the quartermaster run-history pattern) so none is
  promoted twice.
- **Bounds + visibility:** cap `CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN` (default 5). Log every
  promote and every skip with reason.

## 8. Config / env (all OSS-core; surfaced in `config.ts` print + `doctor`)

| Var | Default | Purpose |
|---|---|---|
| `CAPTAIN_MEMO_REMEMBER_DIR` | `~/.claude/memory/` | promotion target; CLI default when no project cwd |
| `CAPTAIN_MEMO_PROMOTE_ENABLE` | `0` (off) | master switch for autonomous promotion |
| `CAPTAIN_MEMO_PROMOTE_INTERVAL_MS` | `21600000` (6h) | promotion tick cadence |
| `CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN` | `5` | per-run promotion cap |
| `CAPTAIN_MEMO_REMEMBER_DEDUP_THRESHOLD` | `0.85` | semantic update-in-place cutoff |

These defaults live as named constants in `src/shared/paths.ts` (alongside the existing
`DEFAULT_*` values) and are tunable via env; the integration tests validate behavior at the
defaults. The exact numbers are tuning knobs and do not affect the architecture.

## 9. OSS-cleanliness

All new files (`memory-writer.ts`, `cli/commands/remember.ts`, the MCP tool, the promotion
job, env constants) live in the worker/cli/mcp **core**. Zero federation imports; nothing
touches `branch.ts` or any federation-gated path. The `ci(moat)` guard that fails if
federation code lands on OSS master is unaffected.

## 10. Testing

- **Unit `memory-writer.test.ts`:** required-field contract; frontmatter fill (mock
  transport); deterministic fallback when transport throws; slug/prefix mapping (incl. the
  Claude Code encoding cases); filename-collision dedup; semantic dedup (mock embedder);
  merge-vs-create; atomic write; in-process `indexFile` call (mock ingest).
- **Unit `promotion.test.ts`:** candidate filter; judge gate (mock summarizer); idempotency
  (no re-promote); max-per-run cap; opt-in gate off → no-op.
- **Integration:** worker up → `POST /remember` → assert file on disk + retrievable via
  `/search/memory`; second overlapping call asserts update-in-place (one file, re-chunked).
  CLI smoke. Windows-safe teardown (env-first + best-effort, per recent CI-hardening commits).

## 11. Out of scope (YAGNI)

- No new retrieval/ranking behavior — promoted entries are ordinary `memory_file` docs and
  flow through existing search + tide re-rank.
- No federation / cross-host sync of remembered entries.
- No UI beyond the MCP tool result, CLI output, and existing stats/doctor surfaces.
- No bulk import/migration tool for existing hand-authored files (they already index).

## 12. Open verification items (resolve during implementation, not architecture)

1. Exact Claude Code project-dir slug encoding for `.`, `_`, trailing slash.
2. Validate the default constants (`PROMOTE_INTERVAL_MS` 6h, `PROMOTE_MAX_PER_RUN` 5,
   `DEDUP_THRESHOLD` 0.85) against real corpus behavior; adjust if the integration tests or
   early use show they're miscalibrated.
3. Whether `searchMemory` scoping "to the target dir" is by `source_path` prefix on
   `memory_file` docs or a metadata filter — pick whichever the existing `MetaStore`/search
   supports cleanly.
