# captain-memo — Design Spec

**Status:** Draft for review
**Date:** 2026-05-06
**Author:** Kalin Bogatzevski (drafted with Claude during brainstorming session)
**Project home:** `~/projects/captain-memo/`

---

## TL;DR

`captain-memo` is a Claude Code plugin that replaces `claude-mem` with a stronger, locally-hosted memory layer. It indexes the user's curated memory files, MEMORY.md, skill bodies, and full session history into a single semantically-searchable corpus, embeds them with `voyage-4-nano`, and serves them through both an automatic injection hook and explicit MCP tools.

The plugin is **universal** — usable by any project — and **federated** — per-project config can add remote knowledge sources (e.g., Aelita's KB MCP) for queries that benefit from non-local context. All embedding, vector storage, and retrieval happens on the dev machine; only summarization (Haiku 4.5) and optional federated remote queries leave the box.

The three target outcomes versus today's stack:
1. **Better building** — right context auto-injected, more reliable skill activation, code-aware patterns.
2. **Smaller token usage** — 488-line MEMORY.md becomes a ~35-line essentials stub; details retrieved on demand.
3. **Faster coding** — fewer rediscoveries; cross-session continuity preserved.

Migration plan keeps `claude-mem` operational as a fallback for at least 30 days; original `~/.claude-mem/` data is never touched.

---

## Goals

- **G1 — Replace claude-mem with feature parity + improvements** on embedding quality, search ranking, chunking, and multilingual recall (BG/EN bilingual content).
- **G2 — Index four content channels in v1**: memory detail files, MEMORY.md (transformed to a small stub), skill bodies, and session observations (claude-mem successor scope).
- **G3 — Auto-inject relevant context** on every user prompt via a `UserPromptSubmit` hook with strict latency budget (95p < 250ms).
- **G4 — Stay local for indexing/retrieval**: voyage-4-nano local embedding, Chroma local vector store, SQLite local metadata. Only summarizer (Haiku) and optional federated remotes leave the dev box.
- **G5 — Universal across projects**: per-project config with global defaults; works on any project Kalin starts, not just erp-platform.
- **G6 — Reversible at every step**: rollout phases preserve claude-mem as fallback; rollback is one command at every stage.
- **G7 — Knowledge accumulates indefinitely**: no default retention caps. Deletion is always explicit and reversible.

## Non-Goals

- **Multi-user / shared deployment** — single-user dev plugin. Shared knowledge bases remain a separate concern (Aelita).
- **Real-time / streaming responses** — auto-injection is request-response, not streamed.
- **Distributed Chroma** — single process, single machine. Multi-machine = different design.
- **Telemetry / phone-home** — plugin reports nothing externally.
- **Replacing Aelita** — Aelita continues to serve feature/policy questions for staff and customers. captain-memo is for the developer's local workflow.
- **Sharing infrastructure with Aelita's production deployment** — the plugin runs its own local Voyage instance on the dev machine. It does NOT query, depend on, or share state with the Aelita production Voyage VM. The two systems are fully decoupled by design — Aelita's VM serves Aelita's RAG only; the dev plugin gets its own deployment.

---

## Background & Motivation

**What claude-mem (v9.1.1) does today:**
- Hooks: SessionStart, UserPromptSubmit, PostToolUse, Stop
- Long-lived worker (port 37777) with stdio MCP + HTTP dual interface
- SQLite (~2.1GB) for raw observation/summary records
- Chroma (~344MB) with `all-MiniLM-L6-v2` (Chroma's `default` embedding) for vector search
- Granular per-semantic-field chunking (narrative, each fact, each summary section)
- Hybrid search via Chroma vector + SQLite keyword (`HybridSearchStrategy.ts`)

**Where it falls short:**
1. **Embedding model is weak** — `all-MiniLM-L6-v2` is from 2020, English-mostly, weak on technical and multilingual queries. Notable failures on Bulgarian content (perniklan reply rules, "сметка vs начисление") and exact-match technical queries (GLAB IDs, function names).
2. **Corpus coverage is narrow** — only sees session content (observations, summaries, prompts). Memory files at `~/.claude/projects/.../memory/*.md` and skill bodies are invisible to it.
3. **MEMORY.md is the always-loaded fallback for static memory** — 488 lines, already truncating at line 200, growing unbounded.
4. **Skills trigger by description-match, not content semantics** — wrong skill loads, or none does, depending on prompt phrasing.

**What this design improves:**
- Voyage-4-nano embedding (multilingual, modern)
- Adds three new channels (memory files, MEMORY.md essentials, skill bodies)
- Hybrid search with explicit RRF fusion
- Section-level chunking for skills (not whole-skill)
- Federated remote sources (Aelita KB optional per-project)
- Sovereignty-coherent local stack

---

## High-Level Architecture

```
       ┌─────────────────────────────────────────────────┐
       │              captain-memo (the plugin)             │
       │                                                  │
       │   Hooks (4): SessionStart, UserPromptSubmit,    │
       │              PostToolUse, Stop                   │
       │                       │                          │
       │                       ▼                          │
       │   ┌──────────────────────────────────────────┐  │
       │   │   Worker (long-lived, project-scoped)    │  │
       │   │                                          │  │
       │   │   ┌────────────────┐  ┌──────────────┐   │  │
       │   │   │  Local engine  │  │  Federation  │   │  │
       │   │   │  (Voyage,      │  │  (MCP client │   │  │
       │   │   │   Chroma,      │  │   to remote  │   │  │
       │   │   │   SQLite)      │  │   MCPs)      │   │  │
       │   │   └───────┬────────┘  └──────┬───────┘   │  │
       │   │           ▼                  ▼           │  │
       │   │      Local hits          Remote hits     │  │
       │   │           │                  │           │  │
       │   │           └──────┬───────────┘           │  │
       │   │                  ▼                       │  │
       │   │       Hybrid ranker + RRF fusion         │  │
       │   │                  │                       │  │
       │   │                  ▼                       │  │
       │   │           Top-K returned                 │  │
       │   └──────────────────────────────────────────┘  │
       └──────────────────────────────────────────────────┘
                  ▲                          ▲
                  │ stdio MCP                │ HTTP/MCP client
                  │                          │
            Claude Code                Remote knowledge sources
                                       (Aelita KB MCP, future ones)
```

**Worker process model:** single long-lived process per dev machine, listening on stdio (MCP) for Claude Code's tool calls and HTTP (`localhost:39888`) for hook scripts. Same dual-interface pattern as claude-mem, distinct port to avoid collision.

**Data layout:**
```
~/.captain-memo/
├── vector-db/
│   └── chroma.sqlite3        # Chroma collections per project (am_<project_id>)
├── meta.sqlite3              # Documents, chunks, FTS5, duplicate_clusters, chunk_query_log
├── queue.db                  # Observation queue (WAL mode)
├── pending_embed.db          # Files queued for retry when Voyage was down
├── logs/
│   ├── worker-YYYY-MM-DD.log
│   └── chroma.log
└── config.json               # Global defaults
```

**Per-project config:** `<project_root>/.claude/captain-memo.json` — overrides globals.

---

## Section 1 — Components

| Component | Responsibility | Approx LOC |
|---|---|---|
| `mcp-server.ts` | Stdio MCP, exposes 8 tools. Thin — delegates to worker. | ~100 |
| `worker/index.ts` | Long-running bun process. Owns Chroma client, watcher, embedder. | ~300 |
| `worker/embedder.ts` | Voyage-4-nano REST client. Batched calls, exponential backoff, queue on failure. | ~150 |
| `worker/chroma.ts` | Wraps Chroma MCP subprocess. One collection per project (`am_<project_id>`). | ~150 |
| `worker/search.ts` | Hybrid: Chroma vector + SQLite FTS5 keyword. RRF fusion. | ~180 |
| `worker/meta.ts` | SQLite store: documents, chunks, FTS5, query log, duplicate clusters. | ~200 |
| `worker/watcher.ts` | chokidar; sha-diff per file; chunk-level diff for skills. | ~120 |
| `worker/summarizer.ts` | Haiku 4.5 client; queue polling; structured observation extraction. | ~200 |
| `worker/federation.ts` | MCP client for remote sources; circuit-breaker per source. | ~150 |
| `worker/optimizer.ts` | Nightly duplicate-cluster detection; chunk_query_log writer. | ~150 |
| `hooks/inject.ts` | UserPromptSubmit hook. Calls worker, formats `<memory-context>`, emits to stdout. | ~80 |
| `hooks/session-start.ts` | SessionStart hook. Recent context injection. | ~50 |
| `hooks/post-tool.ts` | PostToolUse hook. Fire-and-forget enqueue. | ~40 |
| `hooks/stop.ts` | Stop hook. Drain + summarize. | ~50 |
| `bin/captain-memo` | CLI: `reindex`, `status`, `stats`, `migrate-from-claude-mem`, `optimize`, `purge`, `forget`. | ~200 |

**Total estimate:** ~3000 LOC TypeScript + ~500 LOC tests.

---

## Section 2 — Chunking Strategy

Content-aware chunking per channel. One chunker per content type.

### Memory detail files (`~/.claude/projects/<proj>/memory/*.md`)
- **Strategy:** 1 chunk per file. Frontmatter to metadata, body embedded.
- **Why:** Each file is already an atomic thought. Splitting fragments meaning.
- **Soft limit:** 2000 tokens per chunk; rare overflow flagged for manual split.

### MEMORY.md
- **Not indexed.** Replaced post-rollout with a small "essentials" stub (~35 lines). Original archived to `MEMORY.md.archive`.
- The stub keeps always-loaded user identity + cross-project rules + current-project anchors.

### Skill bodies (`~/.claude/{plugins,skills}/**/SKILL.md`)
- **Strategy:** Section-aware splitting on `##` headers. Code blocks atomic — never split mid-fence.
- **Soft limit:** 1500 tokens per chunk. Sub-split on `###` if exceeded.
- **Bonus chunk:** "skill summary" = frontmatter description + first paragraph, embedded separately for trigger-style queries.

### Session observations (claude-mem successor)
- **Strategy:** Granular per-semantic-field (matching claude-mem's proven pattern).
- 1 chunk for `narrative`, 1 chunk per item in `facts[]`, 1 chunk per summary field (request, investigated, learned, completed, next_steps, notes).

### Cross-content-type rules
- Frontmatter never embedded — only body/narrative/section text.
- Whitespace normalized; fenced code preserved verbatim.
- No casing changes (preserve `GLAB#367` exact match signal).
- Token counting via tiktoken-compatible tokenizer matching Voyage's input window.

### Estimated v1 corpus
- ~88 memory files × 1 chunk = 88
- ~30 skills × ~10 sections = ~300
- Migrated session history (full claude-mem corpus): ~10,000 chunks
- **Total at launch:** ~10,400 chunks. Trivial for Voyage and Chroma.

---

## Section 3 — MCP Surface & Hook Contract

### MCP tools (8 total)

```typescript
search_memory({
  query: string,
  type?: 'user' | 'feedback' | 'project' | 'reference',
  project?: string,
  top_k?: number = 5,
}): { results: Hit<MemoryMeta>[] }

search_skill({
  query: string,
  skill_id?: string,
  top_k?: number = 3,
}): { results: Hit<SkillSectionMeta>[] }

search_observations({
  query: string,
  type?: 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'decision' | 'change',
  files?: string[],
  since?: string,        // ISO date or relative (e.g., "7d")
  project?: string,
  top_k?: number = 5,
}): { results: Hit<ObservationMeta>[] }

search_all({
  query: string,
  channels?: Array<'memory' | 'skill' | 'observation' | 'remote'>,
  top_k_per_channel?: number = 3,
  total_top_k?: number = 10,
}): { results: Hit[]; by_channel: Record<string, number> }

get_full({ doc_id: string }): { content: string; metadata: Record<string, unknown> }

reindex({
  channel?: 'memory' | 'skill' | 'observation' | 'all' = 'all',
  force?: boolean = false,
}): { indexed: number; skipped: number; errors: number }

stats({}): {
  total_chunks: number;
  by_channel: Record<string, number>;
  last_indexed_at: string;
  embedder: { model: string; endpoint: string };
  remote_sources: Array<{ name: string; healthy: boolean; last_query_ms: number }>;
  duplicate_clusters?: number;        // present only when ≥5 detected (Section 8)
}

status({}): { healthy: boolean; voyage: 'up' | 'down'; chroma: 'up' | 'down'; issues: string[] }
```

**Shared `Hit` shape:**
```typescript
type Hit<TMeta> = {
  doc_id: string;
  source_path: string;
  title: string;
  snippet: string;       // ~200-token excerpt
  score: number;         // RRF-fused, 0-1
  channel: 'memory' | 'skill' | 'observation' | 'remote';
  metadata: TMeta;
}
```

### Hooks (4 total)

| Hook | Endpoint | Behavior | Failure mode |
|---|---|---|---|
| `UserPromptSubmit` | `POST :39888/hook/prompt` | Search top-5, format `<memory-context>`, emit to stdout. 800ms hard cap. Skip on prompts <10 chars or no-op tokens (`ok`, `continue`). | Worker unreachable → empty stdout → no injection |
| `SessionStart` | `POST :39888/hook/session-start` | Inject recent context: last 5 session summaries + active project memories + git state. Larger token budget (3000). | Same — empty injection |
| `PostToolUse` | `POST :39888/hook/observation` | Enqueue tool-use payload. Fire-and-forget (does not block tool execution). | Drop event if queue full or worker down |
| `Stop` | `POST :39888/hook/session-stop` | Drain queue for sessionId, run final summarization, index session summary. | Queue persisted; recoverable on next session start |

### `<memory-context>` envelope

The block below is a *format template* — angle-bracketed names are runtime values populated by the worker, not literal output:

```
<memory-context retrieved-by="captain-memo" project="<project_id>" k="<count>" budget-tokens="1500">
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

**Header degradation flags:** added only when present. Examples:
- `embedder=voyage-4-nano:keyword-fallback=true` (Voyage down, served keyword-only)
- `remote=captain-memo-kb:degraded` (one source unhealthy)

### Federation contract (remote sources)

Each entry in `remote_sources[]` is treated as MCP client with at minimum:
- `search(query: string, top_k?: number) → { results: [{title, snippet, source_uri, score?}] }`
- Optionally `get_full(doc_id)`

The plugin owns: bearer auth from env, 1500ms timeout per source, circuit-breaker (3 failures → 5min cooldown).

---

## Section 4 — Update Mechanism

### Filesystem watcher
- Library: `chokidar` with `awaitWriteFinish: { stabilityThreshold: 500 }`.
- Watched paths: per-project memory + globally-shared skills.
- Events: `add` (embed all chunks), `change` (sha diff → re-embed changed only), `unlink` (drop chunks).

### Incremental embedding algorithm

```
on file_change(path):
    new_content = read(path)
    new_sha = sha256(new_content)
    existing = meta.documents.find(path)

    if existing and existing.sha == new_sha:
        return  # no-op

    new_chunks = chunker(path, new_content)
    new_chunks_with_sha = new_chunks.map(c => ({...c, sha: sha256(c.text)}))

    if existing:
        old_chunks = meta.chunks.filter(doc_id = existing.id)
        to_add  = new_chunks_with_sha.where(sha not in old_chunks.shas)
        to_drop = old_chunks.where(sha not in new_chunks_with_sha.shas)
    else:
        to_add  = new_chunks_with_sha
        to_drop = []

    embeddings = voyage.embed(to_add.map(c => c.text))   # batch 128
    chroma.delete(to_drop.map(c => c.chunk_id))
    chroma.add(to_add.zip(embeddings))
    meta.upsert_document(path, new_sha, new_chunks_with_sha)
```

### Observation queue (PostToolUse → Stop pipeline)

SQLite WAL-mode table:
```sql
CREATE TABLE observation_queue (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  payload JSON NOT NULL,
  status TEXT NOT NULL,           -- pending | processing | done | failed
  retries INTEGER DEFAULT 0,
  created_at_epoch INTEGER NOT NULL,
  processed_at_epoch INTEGER
);
CREATE INDEX idx_status ON observation_queue(status, created_at_epoch);
CREATE INDEX idx_session ON observation_queue(session_id);
```

Worker poll thread (5s interval) batches up to 20 pending rows → Haiku summarizer → embed → upsert. On `Stop` hook, drain remaining queue for that session and run final summary.

### Migration command

`captain-memo migrate-from-claude-mem` (one-time, idempotent):
1. Open `~/.claude-mem/claude-mem.db` read-only (never modified).
2. Read all `observations` + `session_summaries` for the current/specified project.
3. Reformat to new chunking schema, batch-embed with Voyage.
4. Write to new Chroma collection + meta SQLite.
5. Print summary; original `~/.claude-mem/` left intact.

### Reindex CLI

```
captain-memo reindex                                   # all channels, sha-diff
captain-memo reindex --channel memory                  # specific channel
captain-memo reindex --channel skill --force           # ignore cache, re-embed
captain-memo reindex --project <id>                    # specific project
captain-memo reindex --since 7d                        # recent only
```

---

## Section 5 — Failure Modes & Error Handling

**Principle:** the plugin must never block Claude Code's interactive experience. Every hook has a hard timeout. Every layer degrades gracefully.

### Failure matrix

| Component | Failure | Behavior |
|---|---|---|
| Worker process | Crashed | Hook fails connect within 200ms → empty stdout → no injection |
| Voyage endpoint | Down/timeout | Indexing: queue file in `pending_embed`, retry every 60s. Hook query: keyword-only fallback via SQLite FTS5. |
| Chroma subprocess | Crashed | Same — keyword-only via FTS5 |
| SQLite metadata | Locked/corrupt | Retry with exp backoff (3 tries), then fail loudly to `status()` |
| Disk full | ENOSPC | Worker pauses indexing; `status()` reports `disk_free < 100MB` |
| Haiku API | Down/429 | Summarizer marks rows `failed`, retries (1m, 5m, 30m). Drops after 3 retries; observation never stored. |
| Remote MCP | Timeout/auth | Mark unhealthy; circuit-breaker; probe every 5min |
| Watcher event loss | Silent (rare) | Hourly heartbeat reindex catches drift via cheap sha-diff |

### Hook timeout budget (UserPromptSubmit)

Total: **800ms hard cap.**
- 200ms connect-to-worker
- 500ms local search (vector + keyword + ranker)
- 300ms parallel remote search (additive, cancelled at 300ms)
- 95p typical: ~150ms
- 99p: ~400ms

### Embedding failure → queue, don't drop

Voyage outage during file edit:
1. File added to `pending_embed` table with sha + path.
2. Watcher continues — does NOT block.
3. Background retry every 60s.
4. On Voyage recovery, queue drains automatically.

### Remote MCP circuit-breaker

Per source: 3 consecutive failures → mark unhealthy, skip in queries. After 5min, probe; on success, reactivate.

### Disk space management

| What | Default retention | Cap |
|---|---|---|
| All knowledge content (memory, skills, observations, raw queue) | **Forever** | Manual `purge`/`forget` only |
| Operational logs | 90 days rotated | Configurable for compliance |
| Embedding cache | n/a | Cleared on `--force` reindex (model swap) |

**Single rule: knowledge accumulates indefinitely. No default decay. Deletion always requires explicit user action and is reversible (archive, not delete).**

---

## Section 6 — Testing Strategy

### Five test layers

| Layer | Frequency | Tool |
|---|---|---|
| Unit tests (~50 expected) | Every commit | `bun test` |
| Integration tests (~15 paths) | Every commit | `bun test` w/ real Chroma + Voyage stub |
| Hook contract tests | Every commit | scripted hook invocation, golden-file diff |
| Retrieval-quality eval | Every PR + manual on tuning | custom eval runner |
| Migration & load tests | Pre-release + infra changes | `bun test` + load harness |

### Retrieval-quality eval — the critical layer

**Eval set structure** — `tests/eval/golden-queries.json`:
- ~50 hand-labeled `(query, expected_top_result_id)` pairs sampled from real workflow
- Coverage: English, Bulgarian, exact-match (file paths, GLAB IDs), semantic, multi-channel, no-result
- Built via `captain-memo eval extract-from-transcripts --last 30d` + manual labeling

**Eval scope structure** (Section 6 decision = option C):
- Shared **core eval** — cross-project memories + skills (lives in plugin repo)
- Per-project eval addons — project-specific memories/observations (lives in project's `.claude/`)
- Combined for project's full eval

**v1 quality targets:**

| Metric | Target |
|---|---|
| Recall@1 | ≥ 60% |
| Recall@5 | ≥ 90% |
| MRR (top 10) | ≥ 0.75 |
| Bulgarian-query Recall@5 | ≥ 80% |
| Exact-match Recall@1 | ≥ 95% |
| No-result rate | ≤ 5% |

**Below target on any metric → don't ship; tune chunking/embedding first.**

### v1 release gate

| Criterion | Pass condition |
|---|---|
| Unit tests | 100% pass |
| Integration tests | 100% pass |
| Hook contract tests | 100% pass |
| Retrieval eval | All 6 metrics meet v1 targets |
| Load test | 95p hook latency < 250ms, no observation loss over 5min @ 100rpm |
| Migration test | Idempotent, full claude-mem DB migrates without loss |
| Manual smoke (Kalin, 1 day real use) | No regression vs claude-mem |

---

## Section 7 — Migration & Rollout

### Five-phase rollout

| Phase | Duration | What changes | Revert action | Done when |
|---|---|---|---|---|
| 0. Install | 1 day | Local voyage-4-nano deployed on dev box, then captain-memo installed with hooks DISABLED | Uninstall plugin + tear down local Voyage instance | Voyage reachable on `localhost:8124`; smoke + `status` healthy |
| 1. Shadow mode | 3-5 days | Initial indexing, eval set built, claude-mem unchanged, manual comparison | Uninstall | All v1 metrics met |
| 2. claude-mem migration | 1 day | `migrate-from-claude-mem` runs (read-only on claude-mem) | Drop new vector store | Spot checks pass |
| 3. Dual-running | 7-14 days | captain-memo `UserPromptSubmit` hook ENABLED. claude-mem hooks still ENABLED. Hook output deduplicates by `doc_id` + `source_path`. | Disable captain-memo hook | No felt regression vs baseline |
| 4. claude-mem hooks off | indefinite | captain-memo solo. claude-mem MCP search still available manually for ~30 days. | Re-enable claude-mem hooks | 30 days stable |
| 5. Sunset | n/a | claude-mem hooks + MCP disconnected. Original DB stays on disk indefinitely. | Reinstall claude-mem | Multiple months stable; no incidents |

### MEMORY.md transformation

The current MEMORY.md serves two purposes; split them:
- **Always-loaded essentials** (~30 lines: user identity, cross-project rules, current-project anchors) — KEEP always-loaded.
- **Detail index** (~450 one-line links) — REPLACED by `search_memory()` + auto-injection.

New MEMORY.md is a small "essentials" file — illustrative template structure below. The *content* is per-user (each developer fills in their own identity, rules, and current-project anchors during install or first session). The example below shows what one user's filled-in version might look like; it is NOT a default shipped with the plugin.

```markdown
# Memory

> Detailed memories are indexed by captain-memo. Use `search_memory(query)` for
> specific lookups, or rely on auto-injection on prompt submit.
> Original index archived at `MEMORY.md.archive` (recoverable).

## Always-Loaded Essentials

### User
- [Your name, role, key identifiers].
- Conversation language: [your default].
- [Other persistent personal facts].

### Cross-project rules
- [Habits and rules you want loaded for every project].

### Current project: <project_id>
- [Project-specific anchors that should always be in context].

## Detail search

Detail memory files: `./memory/*.md`.
Use `search_memory(query)` to find specific entries.
```

**Filled-in example** (one user, illustrative — NOT shipped as default):

```markdown
## Always-Loaded Essentials

### User
- Kalin Bogatzevski (id=1, HQ owner). Ivan (id=3) is co-owner.
- Conversation language: English. BG only for BG-audience artifacts.
- Source IPs: 151.237.94.97 (laptop), 85.187.62.150 (home).
- Owns: 123NET (SA), NetLine (BG), Yafibr (Africa), ISPCQ (platform brand).

### Cross-project rules
- Reference data by ID, not value.
- "fix" not "patch" — address root cause.
- Use permissions not roles in code (`acl_check_permission`).
- Subagents for parallel work; never for tightly-coupled frontend.
- Run bulgarian-language-review on any BG output.

### Current project: erp-platform
- Multi-tenant PHP ERP, two tenants (123NET / NetLine).
- Always load `erp-coding-standards` + `erp-design-system` skills.
- Deploy to BOTH servers. Bump CSS/JS versions.
```

The plugin install includes a guided one-time prompt to seed this section; subsequent edits are user-managed.

**Migration:** snapshot original to `MEMORY.md.archive`, generate new shape (curated essentials reviewed with user), watcher re-indexes the small new version.

### Day-1 user experience

The dev box does NOT have a local voyage-4-nano running yet. Plugin install therefore includes a one-time Voyage deployment step.

1. **Plugin install** (via plugin marketplace or `npm install`) — gets plugin code, CLI binary, hook scripts.
2. **Local Voyage deployment** — `captain-memo install-voyage --artifact <path-or-source>` runs the deployment recipe (replicates the deployment pattern used for Aelita's prod VM, but on the dev machine, with its own data dir and port `8124` by default). One-time, ~5-30 min depending on artifact form (Docker container, binary, etc.). Detailed in the implementation plan.
3. **Setup hook checks prerequisites** — Voyage endpoint reachable, Haiku key present, disk space adequate.
4. **Initial indexing** of memory + skills runs in background (~1-2 min).
5. **Hooks disabled by default.** CLI: `captain-memo eval` to verify retrieval quality, `captain-memo enable-hooks` to activate auto-injection.

The Voyage deployment step (#2) is the only non-trivial install dependency; everything else is standard plugin lifecycle.

### Fallback paths

| If breaks | What you do | What still works |
|---|---|---|
| Worker crashes | `captain-memo restart` | claude-mem (Phase 3); empty injection (Phase 4+) |
| Voyage persistent failure | `captain-memo disable-hooks` | claude-mem; captain-memo tools in keyword-only mode |
| New MEMORY.md missing context | `cp MEMORY.md.archive MEMORY.md` | Old behavior fully restored within 1 prompt |
| Migration corrupts new index | Drop `~/.captain-memo/`, reinstall, re-migrate | Original `~/.claude-mem/` was never touched |
| Both stacks misbehaving | Disable both via `~/.claude/settings.json` hook config | Plain Claude Code without memory injection |

---

## Section 8 — Memory Hygiene & Optimization

### Principle

Detection runs automatically and is always passive. Action is always user-confirmed and reversible. Auto-merging is never default behavior.

### Three optimization dimensions

| Dimension | Detection | User action |
|---|---|---|
| Near-duplicates | Cosine similarity ≥ 0.92 within same channel; nightly cluster computation | `captain-memo optimize --review` (Phase 1.5) |
| Stale entries | Not retrieved in 12+ months AND `mtime` 12+ months. 2x threshold for manually-curated content. | Same `--review` flow |
| Contradiction candidates | Similarity 0.65-0.85 + Haiku/Qwen "do these contradict?" check (weekly, optional) | Same `--review` flow |

### Detection algorithm (near-duplicates, nightly)

1. For each channel, pull all chunk embeddings.
2. For each chunk, find top-K nearest neighbors (K=5) within same channel.
3. If neighbor cosine ≥ 0.92 AND authored within 6 months of chunk → flag pair.
4. Cluster transitively (A↔B + B↔C → {A, B, C}).
5. Store cluster IDs in `meta.duplicate_clusters` with `status='unreviewed'`.

### Stats surfacing (option C from brainstorm)

- 0-4 clusters detected → not surfaced in `captain-memo stats` (no nag)
- 5+ clusters detected → `stats` includes `duplicate_clusters: N` and pointer to optimize command
- Always available via `captain-memo optimize --dry-run`

### v1 vs Phase 1.5 split

| Capability | v1 | Phase 1.5 |
|---|---|---|
| Near-duplicate detection (nightly) | ✅ | — |
| Cluster surface in `stats` (threshold ≥ 5) | ✅ | — |
| `optimize --dry-run` | ✅ | — |
| `optimize --review` (interactive merge UI) | — | ✅ |
| Stale detection | — | ✅ |
| Contradiction detection (Haiku/Qwen) | — | Phase 2 |
| Cross-channel optimization | — | Phase 2 |

### Storage additions

```sql
CREATE TABLE duplicate_clusters (
  cluster_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  chunk_ids JSON NOT NULL,
  avg_similarity REAL NOT NULL,
  detected_at_epoch INTEGER NOT NULL,
  status TEXT NOT NULL,                -- unreviewed | reviewed-kept | merged | dismissed
  resolution JSON                      -- if merged: {canonical_id, archived_paths[]}
);

CREATE TABLE chunk_query_log (
  chunk_id TEXT NOT NULL,
  retrieved_at_epoch INTEGER NOT NULL,
  query_hash TEXT,
  rank INTEGER,
  PRIMARY KEY (chunk_id, retrieved_at_epoch)
);
CREATE INDEX idx_chunk_log ON chunk_query_log(chunk_id, retrieved_at_epoch DESC);
```

---

## Decision Log

| # | Decision | Rationale |
|---|---|---|
| D1 | MVP shape: phased — A "compress + retrieve existing" first, B "add new corpus" later | A delivers all 3 goals on day 1; B amplifies via same infra |
| D2 | Phase 1 channels: memory files + MEMORY.md + skill bodies (A+B+E) | Smallest set hitting all 3 goals (better/cheaper/faster) |
| D3 | Architecture: hybrid hook + tool-call (claude-mem-pattern + Voyage embedder) | Auto-injection needed; Claude's tool-call judgment is unreliable for memory |
| D4 | Embedder: voyage-4-nano (free tier; upgradable to larger Voyage models) | Multilingual, modern, sovereignty-coherent local stack |
| D5 | Embedder deployment: workstation-local on the dev machine; **NEVER** Aelita's prod Voyage VM | Universal plugin requirement; no infra dep; Aelita's prod is for Aelita only and must stay decoupled |
| D6 | Plugin shape: complete claude-mem successor (4 hooks + MCP + summarizer) | User specifically asked for replacement, not augment |
| D7 | Plugin scope: universal across projects, with per-project remote-source config | Reusable across projects; ERP gets Aelita federation, others may not |
| D8 | Summarizer: Haiku 4.5 (auto-upgrade to 4.6 when available) | Best structured-output quality; tool-use payloads are less sensitive than memory content |
| D9 | claude-mem migration: ALL data migrated; original `~/.claude-mem/` retained indefinitely | User directive; full history preserved |
| D10 | Retention: forever by default for all knowledge content | Multi-year projects; deletion always explicit |
| D11 | Eval set scope: shared core + per-project addons (option C) | Cross-project rules tested everywhere; project specifics local |
| D12 | Optimization v1: detection only; review/merge in Phase 1.5 | Establish data signal before committing to UX |
| D13 | Stats surfacing: threshold-based (≥5 clusters) | Useful signal without nag |
| D14 | `<memory-context>` envelope: show scores; degradation flags only when present | Helps Claude weight trust; healthy state stays clean |
| D15 | Tool surface: both `search_all` (default) and channel-specific tools | Ergonomic common case + explicit follow-up |

---

## Future Phases

**Phase 1.5** (after v1 stable, ~2-4 weeks):
- Interactive `optimize --review` flow (TUI or CLI prompts)
- Stale entry detection
- Larger Voyage model upgrade path (voyage-3, voyage-3-large) if eval shows v1 ceiling
- **Pluggable embedder fallback** — ship `bge-m3` via Ollama as the no-Voyage-license-needed alternative. Lowers friction for first-time users (no Voyage deployment required to try the plugin) and is a prerequisite for Phase 2 OSS readiness.

**Phase 2** (after Phase 1.5 stable):
- Aelita KB indexing as a new local channel (separate from federation)
- Code pattern extraction agent (uses Qwen2.5-Coder or similar to mine codebase patterns)
- ERP_UNIFIED_DOCS indexing
- Contradiction detection (LLM-assisted)
- Cross-channel optimization (memory ↔ skill consolidation)
- **OSS-readiness pass** — preparing for public release:
  - License chosen + applied (AGPL-3.0 mirrors claude-mem; MIT/Apache friendlier to commercial adopters; decision deferred until pre-release)
  - README + install guide + CONTRIBUTING.md
  - Privacy/data-handling docs (what stays local, what goes to Haiku, no telemetry)
  - CI: unit + integration + retrieval-quality eval (the eval-CI is unusual + a strong public differentiator)
  - Optional: GitHub mirror in addition to primary GitLab repo for discoverability
- **Public repo creation** — separate task: scaffold the public-facing repo with the items above, push initial release.

**Beyond Phase 2:**
- Re-ranker over retrieved results (small LLM scoring top-20 → top-5)
- Diff-aware observation summarization (parses unified diffs)
- Auto-generated commit/PR descriptions using indexed history

---

## Appendix A — Configuration Schema

### Global config (`~/.captain-memo/config.json`)

The `embedder.endpoint` value is determined at install time by the setup hook based on the user's *local* Voyage deployment on the dev machine (default `localhost:8124` if not detected). The endpoint must point to a Voyage instance dedicated to the dev plugin — it must NOT point at any production Voyage VM (e.g., Aelita's). Below shows the install-time-resolved shape:

```json
{
  "embedder": {
    "kind": "voyage",
    "endpoint": "http://localhost:8124/v1/embeddings",
    "model": "voyage-4-nano",
    "max_batch_size": 128,
    "timeout_ms": 1500
  },
  "summarizer": {
    "kind": "haiku",
    "model": "claude-haiku-4-5",
    "max_retries": 3
  },
  "vector_store": "~/.captain-memo/vector-db/",
  "default_top_k": 5,
  "hook": {
    "auto_inject": true,
    "max_tokens_injected": 1500,
    "skip_short_prompts_chars": 10,
    "skip_no_op_tokens": ["ok", "continue", "yes", "go"]
  },
  "retention": {
    "knowledge_content_days": null,        // forever
    "operational_logs_days": 90
  },
  "optimization": {
    "duplicate_threshold": 0.92,
    "stale_threshold_months": 12,
    "stats_surface_threshold": 5
  }
}
```

### Per-project config (`<project_root>/.claude/captain-memo.json`)

```json
{
  "project_id": "erp-platform",
  "channels": {
    "memory_files": true,
    "memory_md_index": true,
    "skill_bodies": true,
    "session_observations": true
  },
  "remote_sources": [
    {
      "name": "captain-memo-kb",
      "transport": "mcp",
      "endpoint": "https://aelita.123net.link/mcp",
      "auth": { "kind": "bearer", "token_env": "CAPTAIN_MEMO_TOKEN" },
      "tools": ["search_kb", "get_article"],
      "weight": 0.4,
      "timeout_ms": 1500
    }
  ],
  "retention_overrides": {}
}
```

---

## Appendix B — Storage Layout

```
~/.captain-memo/
├── config.json                  # Global defaults
├── vector-db/
│   └── chroma.sqlite3           # All projects' Chroma collections
├── meta.sqlite3                 # documents, chunks, FTS5, duplicate_clusters, chunk_query_log
├── queue.db                     # observation_queue (WAL mode)
├── pending_embed.db             # Files queued during Voyage outages
├── logs/
│   ├── worker-2026-05-06.log
│   ├── chroma.log
│   └── migration.log            # one-time migration record
└── archive/
    └── <project_id>/
        └── <chunk_id>.txt       # Archived merges from optimize --review

<project_root>/.claude/
├── CLAUDE.md                    # Existing: project instructions
├── captain-memo.json              # Per-project plugin config
└── eval/
    └── golden-queries.<project>.json   # Per-project eval addons
```

---

## Appendix C — SQLite DDL (meta.sqlite3)

```sql
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  source_path TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,            -- memory | skill | observation | mem_md_stub
  project_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  mtime_epoch INTEGER NOT NULL,
  last_indexed_epoch INTEGER NOT NULL,
  metadata JSON
);
CREATE INDEX idx_documents_project ON documents(project_id, channel);

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL UNIQUE,    -- exposed identity, used by Chroma + get_full
  text TEXT NOT NULL,
  sha TEXT NOT NULL,
  position INTEGER NOT NULL,        -- ordering within document
  metadata JSON
);
CREATE INDEX idx_chunks_document ON chunks(document_id);

CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id');

CREATE TABLE duplicate_clusters (
  cluster_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  chunk_ids JSON NOT NULL,
  avg_similarity REAL NOT NULL,
  detected_at_epoch INTEGER NOT NULL,
  status TEXT NOT NULL,             -- unreviewed | reviewed-kept | merged | dismissed
  resolution JSON
);

CREATE TABLE chunk_query_log (
  chunk_id TEXT NOT NULL,
  retrieved_at_epoch INTEGER NOT NULL,
  query_hash TEXT,
  rank INTEGER,
  PRIMARY KEY (chunk_id, retrieved_at_epoch)
);
CREATE INDEX idx_chunk_log ON chunk_query_log(chunk_id, retrieved_at_epoch DESC);
```

---

## End of Spec

Approved sections: 1-8. Ready for user review and implementation plan.
