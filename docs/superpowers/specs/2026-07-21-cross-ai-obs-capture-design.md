# Cross-AI observation capture (codex + agy → obs)

**Date:** 2026-07-21
**Status:** Implemented in **0.26.0** (codex, agy, gemini, kimi, opencode). See §8.
**Editions:** OSS (`master`). Federation (`captain-memo-fed`) is a follow-on, same interface.
**Owner ask:** make non-Claude CLIs (agy first, codex alongside) produce observations the
way Claude Code sessions do — captured transparently, no change to how the user launches
the tool, **on by default**.

---

## 1. Problem

Observations are produced by the worker summarizing *raw session events*. Those events are
captured and POSTed to the worker by exactly one thing today: the **Claude Code plugin
hooks** (`src/hooks/{session-start,user-prompt-submit,post-tool-use,pre-compact,stop}.ts`
→ `/observation/enqueue` + `/observation/flush`). No other tool has a capture path.

Verified consequence (this machine, shared corpus `/home/kalin/.captain-memo`, 104k+ rows):
`origin_agent` is only ever `claude-code` or `null` — agy/codex/gemini have produced **zero
observations, ever**. `captain-memo connect <tool>` wires *recall only* (MCP + skill); it
installs no capture hook (`src/cli/cross-ai.ts:13-15`). Confirmed live: a full agy session
(read+write files) captured nothing (queue stayed `0/0`, no new row).

`captain-memo-fed` has per-tool session *adapters* (`src/worker/federation/session/*-adapter.ts`)
but those are **co-session** machinery (spawning other CLIs as fleet workers over tmux), not
obs capture — and it shares the same corpus, which also has zero non-Claude obs. So this is
genuinely net-new.

## 2. Verified current state (what we build on)

| Fact | Value | Source |
|---|---|---|
| Enqueue endpoint | `POST /observation/enqueue`, body = `RawObservationEvent` | `src/hooks/post-tool-use.ts:44-58` |
| Flush endpoint | `POST /observation/flush {session_id, max}` → creates obs | `src/hooks/stop.ts:15-20`, `src/cli/commands/observation.ts` |
| Pipeline is origin-agnostic | flush summarizes queued events regardless of origin; `origin_agent` carried onto the row | `src/worker/index.ts:681,742` |
| `origin_agent` is a validated enum | `[claude-code, codex, cursor, gemini, opencode, vibe, vscode, jetbrains, unknown]` | `src/shared/origin-agent.ts:12-14` |
| → `codex` already allowed; **`agy` is not** | one additive enum entry needed | same |
| agy has **no** hook system | subcommands: agent/models/plugin/update…; `settings.json` has no `hooks` key | verified `agy --help`, `~/.gemini/settings.json` (v1.1.4) |
| agy persists each session as SQLite | `~/.gemini/antigravity-cli/conversations/<uuid>.db` (~160 KB) | verified on-disk |
| agy transcript is protobuf-in-BLOB | `steps.step_payload` BLOB, `step_format INTEGER`; text recoverable heuristically (a `strings` pass recovered the exact prompt, tool-call JSON, outputs, file paths) | verified on a known-content `.db` |
| codex is hook-enabled + JSONL | trust-gated hooks + `exec --json`; persists per-session rollout JSONL | verified `codex --help` (0.144.6) |
| codex per-session transcript | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`; line 1 `session_meta` with `id`, `cwd`, `cli_version` | verified sample file |

`RawObservationEvent` fields (the shared target for every source):
`{ session_id, project_id, prompt_number, tool_name, tool_input_summary,
tool_result_summary, files_read[], files_modified[], ts_epoch, branch, origin_agent }`
(`src/shared/types.ts`, consumed at `src/worker/index.ts:1970-1974`).

## 3. Design

A worker-side background **driver** polls a list of **capture sources**, one per non-Claude
tool. Each source finds *finished* local sessions, extracts their transcript into
`RawObservationEvent[]`, and posts enqueue → flush. Everything downstream (summarizer,
embedding, obs store, `origin_agent` stamping) is reused **unchanged**.

### 3.1 Source interface (thin — no plugin framework)

```ts
interface CaptureSource {
  id: 'codex' | 'agy';
  originAgent: OriginAgent;             // 'codex' | 'agy'
  available(): boolean;                 // tool's session dir exists on this host
  enabled(): boolean;                   // default true; env opt-out
  discover(sinceEpoch): SessionRef[];   // finished, not-yet-ingested sessions
  extract(ref): RawObservationEvent[];  // transcript → events (origin_agent set)
}
```

Driver loop (reuses the obs-tick cadence, ~30–60 s; runs only when `!readOnly`):
for each source where `available() && enabled()` → `discover()` → for each new session:
`extract()` → enqueue each event → `flush(session_id)` → record ingest-state. Failures are
per-session isolated and logged (`[capture:<id>]`), never crash the worker (mirrors the
stop-hook flush error handling).

### 3.2 codex source (clean)

- **Input:** watch `~/.codex/sessions/**/rollout-*.jsonl` (dir overridable).
- **Done:** mtime idle > `N` (no live append).
- **Extract:** parse JSONL. `session_meta` → `session_id = payload.id`, `project_id =
  resolveProjectId(payload.cwd)`. Map each turn / `function_call` / `message` line → one
  `RawObservationEvent` (`tool_name` from the event; `tool_input_summary` /
  `tool_result_summary` = `summarize(...)`; `files_read`/`files_modified` from shell/apply
  args where present; `ts_epoch` from the line timestamp). `origin_agent:'codex'`.

### 3.3 agy source (messy, but viable)

- **Input:** watch `~/.gemini/antigravity-cli/conversations/*.db` (dir overridable).
  **Must exclude** the summarizer's isolated home `<DATA_DIR>/agy-home/...` so we never
  capture our own summarize calls when `summarizer=agy` (`src/worker/summarizer-agy.ts:38`).
- **Done:** no `<uuid>.db-wal` present **and** mtime idle > `N` (WAL gone ⇒ agy closed it).
- **Extract:** open `<uuid>.db` **readonly**; read `steps` ordered by `idx`; extract readable
  text from each `step_payload` BLOB heuristically (protobuf, no published schema). Map steps
  → events; `session_id = <uuid>`; `project_id` from any `Cwd` recovered in the payload else
  `unknown`. `origin_agent:'agy'` (**new enum value**).
  `// ponytail: heuristic protobuf-text extraction, no schema; upgrade if Antigravity documents it.`

### 3.4 Shared plumbing

- **origin_agent:** add `'agy'` to `ORIGIN_AGENTS` (`src/shared/origin-agent.ts`) — additive,
  backward-compatible per its own contract. `codex` needs no change.
- **Ingest-state table** (new, in `observations.db`, via the existing migrations infra
  `OBSERVATIONS_STORE_MIGRATIONS`): `capture_ingested(source TEXT, session_id TEXT,
  last_marker TEXT, ingested_at_epoch INT, PRIMARY KEY(source, session_id))`. `last_marker`
  = mtime/byte-offset/max-step-idx so a restart or a multi-turn session that grew doesn't
  double-ingest; re-`discover()` skips sessions whose marker is unchanged.
- **On by default, with a backfill guard.** A source is active when its session dir exists
  (`available()`) unless explicitly disabled (`CAPTAIN_MEMO_CAPTURE_CODEX=0` /
  `..._AGY=0`). On **first** activation on a host, seed a cutoff = now, so only sessions
  finished *after* enable are captured — a fresh default-on install does **not** summarize
  the entire pre-existing history (cost + noise). Explicit `captain-memo capture backfill
  [--source <id>] [--since <date>]` ingests history on demand.
- **Config surface:** `CAPTAIN_MEMO_CAPTURE_CODEX` / `_AGY` (default on), `..._CODEX_DIR` /
  `..._AGY_DIR` (dir overrides), `..._QUIESCE_MS` (done threshold). Shown in
  `captain-memo config show` and `doctor` (a `cross-ai capture` check: per source →
  available? enabled? last ingest + count).

## 4. Data flow

```
agy/codex session ends → transcript on disk
   → driver tick: source.discover() finds it (mtime-quiescent, marker changed)
   → source.extract() → RawObservationEvent[]  (origin_agent = agy|codex)
   → POST /observation/enqueue (per event)
   → POST /observation/flush {session_id}
   → [existing] summarizer → observation rows stamped origin_agent
   → capture_ingested row recorded (marker advanced)
```

## 5. Scope / non-goals

- **Machine-local only.** Each worker captures *its own host's* codex/agy sessions into *its
  own* corpus. The user's agy laptop needs its own captain-memo worker running this capture;
  cross-laptop sharing is federation, **out of scope** here.
- **No dependency on codex's hook API** — the verified JSONL rollout is the input. (Native
  codex hooks are a possible future optimization, not needed.)
- **gemini / cursor / opencode / vibe** = future sources, same interface. Not built now.
- **`captain-memo-fed`** port = follow-on (the user's codex MCP currently points there).
- No change to recall wiring, the summarizer, or the obs store schema beyond the two additive
  items above (enum value + ingest-state table).

## 6. Testing

- **codex source:** fixture = a real `rollout-*.jsonl` → assert `extract()` yields the
  expected events, `session_id`/`project_id`/`origin_agent:'codex'`, files parsed from a
  shell/apply line.
- **agy source:** fixture = a real `<uuid>.db` (checked-in binary) → assert `extract()`
  recovers the known prompt/tool text and stamps `origin_agent:'agy'`; assert the isolated
  `agy-home` path is excluded.
- **driver dedup:** discover the same session twice → exactly one ingest (marker unchanged ⇒
  skipped).
- **backfill guard:** with pre-existing (pre-cutoff) sessions present, first tick ingests
  none; `capture backfill` ingests them.
- **end-to-end:** drop a fixture into a temp session dir, run one driver tick against a test
  worker, assert an observation row appears with the right `origin_agent`.

## 7. Risks

- **agy extraction is lossy** (heuristic, undocumented protobuf; format can shift between agy
  versions). Mitigation: extraction feeds a *summarizer* that distills anyway; a version bump
  degrades to weaker text, not a crash. Marked with a `ponytail:` ceiling + a source-level
  version note.
- **Default-on backfill flood** — mitigated by the first-activation cutoff (§3.4).
- **Double-capture when `summarizer=agy`** — mitigated by excluding the isolated `agy-home`
  (§3.3).
- **Session-done misfire** (ingesting a still-open session) — mitigated by WAL-absence (agy) +
  mtime-quiescence; worst case a later turn re-ingests under the same `session_id` and the
  marker advances (no duplicate row per session, but a session could summarize twice if it
  resumes far later — acceptable; `resume` is rare).

## 8. Implementation status (shipped in 0.26.0)

Built as `src/worker/capture/` — a thin `CaptureSource` interface + a driver
(`runCaptureTick`), a dedup/cutoff store (`state.ts`), and per-tool readers.
Sources produce `RawObservationEvent[]`; the existing obs-tick summarizes them.
`origin_agent` gained `agy` + `kimi`. All five live-verified against real
sessions producing real observations.

Per-tool capture-readiness matrix (verified by filesystem inspection on this host
and on `ae.123net.link`, plus docs where a tool wasn't installed):

| Tool | Status | Transcript on disk | Format | Difficulty |
|---|---|---|---|---|
| codex | ✅ shipped | `~/.codex/sessions/**/rollout-*.jsonl` | JSONL | done |
| agy | ✅ shipped | `~/.gemini/antigravity-cli/conversations/*.db` | SQLite (protobuf) | done |
| gemini | ✅ shipped | `~/.gemini/tmp/*/chats/session-*.json` | JSON | done |
| kimi | ✅ shipped | `~/.kimi/sessions/*/*/context.jsonl` | JSONL | done |
| opencode | ✅ shipped | `~/.local/share/opencode/opencode.db` | SQLite (session/message/part) | done |
| cursor | ⏳ next batch | `~/.cursor/projects/*/agent-transcripts/*.jsonl` (+ native `hooks.json`) | JSONL | easy |
| vibe | ⏳ next batch | `~/.vibe/sessions/session_*/messages.jsonl` | JSONL | easy |
| vscode | ⏳ next batch | `~/.config/Code/User/workspaceStorage/*/chatSessions/*.json` | JSON | medium |
| jetbrains | ❌ not feasible | none — IDE-only, no local transcript | — | needs a JVM plugin |

Also shipped: `POST /capture/backfill` + `captain-memo capture <status\|backfill>`,
a `cross-AI capture` line in `doctor`, and capture config in `config show`.
Follow-ons: build cursor/vibe/vscode when a live install is available to test;
port the sources into `captain-memo-fed`.
