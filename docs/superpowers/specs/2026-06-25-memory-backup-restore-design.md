# Memory Backup & Restore — Design

- **Date:** 2026-06-25
- **Branch:** `feat/memory-backup` (off `master`, the OSS edition; worktree `/home/kalin/projects/captain-memo`)
- **Status:** Design — new feature. Edition-agnostic: lands on OSS (`master`) directly and merges to the federation line with zero coupling.
- **Author intent (verbatim):** "implement some kind of memory backup, so that we can move the captains' memories to a new installation or restore them." Two follow-ups: import+merge is a separate next to-do; the feature "has to merge to the OSS version too."

## 1. Goal

One portable, turnkey archive that captures a captain's entire **durable** memory + config, so it can seed a fresh installation or recover a lost one. Restore is a **full replacement** of the local corpus (refuse unless `--force`). Consolidating two live corpora is explicitly out of scope here — that is the deferred `import` command (§11).

Locked decisions (from brainstorming):

1. **Scope:** everything, including secrets (the `worker.env` API keys) — turnkey restore.
2. **Vectors:** ship the vector DB, with an **auto-reindex fallback** when the target embedder/dimension differs.
3. **Live safety:** hot snapshot, the worker stays up during backup.
4. **Encryption:** plain archive + a loud credentials warning. `--encrypt` is *not* built now; the format reserves room for it.
5. **Restore mode:** replace; refuse a non-empty target unless `--force`. Merge is deferred.

## 2. Data model (what "the memories" physically are)

Under `DATA_DIR` (`~/.captain-memo`, override `CAPTAIN_MEMO_DATA_DIR`):

| File | Role | In backup? |
|---|---|---|
| `meta.sqlite3` | `documents` + `chunks` (incl. chunk **source `text`**) — curated memory & skills index | ✅ durable |
| `observations.db` | session voyage-logs | ✅ durable |
| `vector-db/embeddings.db` | `sqlite-vec` embeddings (single SQLite file; tied to embedder + dimension) | ✅ durable |
| `config.json` | corpus config (may be absent) | ✅ if present |
| `queue.db` | transient event queue | ❌ rebuildable |
| `pending_embed.db` | transient pending-embed staging | ❌ rebuildable |
| `*-wal`, `*-shm` | SQLite WAL sidecars | ❌ folded into the snapshot |
| `logs/`, `recall-audit.jsonl`, `eval/`, `*.bak*`, `.install-version`, `*.sock` | logs / scratch / host state | ❌ |
| `federation.json` (+ its `.bak*`) | **federation-edition** host/peer identity | ❌ excluded by design (§9) |

Secrets live in `worker.env`, resolved across (first found wins, federation-mode adds `/etc`): `~/.config/captain-memo/worker.env` (`CONFIG_DIR`), `~/.captain-memo/worker.env`, `/etc/captain-memo/worker.env`. The backup captures the **effective** file the worker actually loads.

**Pivotal fact:** because `meta.sqlite3` keeps every chunk's source `text`, vectors can be rebuilt from source via the existing `reindex` path. That is what makes the auto-reindex fallback (§7) possible.

## 3. Command surface

A `backup` command **group** — deliberately *not* a top-level `restore`, which already exists (observation un-sink). Added to the dispatch in `src/cli/index.ts`.

- `captain-memo backup create [--out PATH] [--no-vectors]`
  → writes `captain-memo-backup-YYYYMMDD-HHMMSS.tar.gz` (default: CWD), `chmod 600`, prints a loud "this archive contains API keys" warning. `--no-vectors` omits `vector-db` (smaller archive; restore always re-embeds).
- `captain-memo backup restore <FILE> [--force] [--reindex]`
  → validate → replace the local corpus. `--force` overrides the non-empty-target guard; `--reindex` forces vector rebuild even on an embedder match.
- `captain-memo backup info <FILE>`
  → print the manifest (counts, embedder, version, platform, secrets/vectors flags) **without** restoring.

CLI-only. No MCP tool — backup/restore is an operator action, not something the model invokes mid-session.

## 4. Archive layout

A gzipped tar of a staging directory:

```
manifest.json
data/meta.sqlite3
data/observations.db
data/vector-db/embeddings.db        # omitted with --no-vectors
config/config.json                  # if present
config/worker.env                   # the effective secrets file
```

Produced via the system `tar` (GNU tar on Linux; `tar.exe`/bsdtar on Windows 10+). Written to `<out>.partial`, then atomically renamed on success.

## 5. `manifest.json`

```jsonc
{
  "format_version": 1,
  "captain_memo_version": "<VERSION>",   // from src/shared/version.ts
  "created_at": "<ISO-8601>",
  "platform": "linux" | "win32",
  "embedder":  { "provider": "...", "model": "...", "dimension": 1024, "endpoint": "..." },
  "summarizer":{ "provider": "...", "model": "..." },
  "includes_secrets": true,
  "includes_vectors": true,
  "files":  [ { "path": "data/meta.sqlite3", "size": 123, "sha256": "..." }, ... ],
  "counts": { "documents": 0, "chunks": 0, "observations": 0, "vectors": 0 }
}
```

Drives: integrity verification (checksums), the `info` view, version/platform-drift warnings, and the vector decision (§7). Identity + counts are read from a live `GET /stats` (exposes `embedder {model, endpoint}` + counts); if the worker is down, fall back to reading config files + opening the DBs read-only.

## 6. Backup flow (no worker downtime)

1. Resolve identity + counts (`GET /stats`, else offline fallback).
2. Create a staging dir.
3. For each durable SQLite DB, open a **separate read connection** and run `VACUUM INTO '<staging>/…'` (path single-quote-escaped — `VACUUM INTO` takes a string literal, not a bound param). WAL mode → a consistent, defragmented single-file copy of the last committed state while the worker keeps writing. No `-wal`/`-shm` needed.
4. Copy `config.json` (if present) + the effective `worker.env` into `config/`.
5. Compute per-file sha256; write `manifest.json`.
6. `tar -czf <out>.partial` the staging dir → `rename` to `<out>`; `chmod 600`; print the secrets warning + a one-line summary (counts, size).
7. Always clean the staging dir (success or failure). Never leave a partial archive at the final path.

## 7. Restore flow (validate-before-touch)

1. Extract to a temp dir. Validate `manifest.json` (format version) and **verify every file's sha256**. Any failure → **abort, nothing on disk touched**.
2. Detect a non-empty local corpus (existing `meta.sqlite3`/`observations.db`/`vector-db` with rows). If non-empty and no `--force` → refuse with a clear message naming `--force`.
3. Stop the worker (`src/shared/worker-control.ts`).
4. Move current durable files aside to `DATA_DIR/.pre-restore-<ts>/` (recoverable rollback — not deleted).
5. Copy restored DBs into `DATA_DIR` (and clear any stale `-wal`/`-shm` of the replaced files). Write `config.json` + `worker.env` to the platform-correct locations (`CONFIG_DIR` for `worker.env`).
6. **Vector decision.** Compare manifest `embedder.model` + `dimension` to the *target's* configured embedder/dim:
   - match, no `--reindex`, vectors present → keep the restored `vector-db`.
   - mismatch, or `--reindex`, or `--no-vectors` archive → drop `vector-db`; mark for rebuild.
7. Start the worker.
8. If rebuild is marked → run `reindex` (worker regenerates vectors from chunk `text` + observations) and surface progress.
9. Verify restored counts against the manifest; print a summary, the `.pre-restore-<ts>` location, and the federation note (§9).

## 8. Components (each independently testable)

- `src/cli/commands/backup.ts` — thin flag parsing + dispatch for `create | restore | info`.
- `src/services/backup/manifest.ts` — manifest type + build/parse/validate + file-checksum helper (reuses `src/shared/sha.ts` `sha256Hex` for the manifest; streams large files for content hashing).
- `src/services/backup/snapshot.ts` — the include **allowlist**, `VACUUM INTO` snapshotting, tar create/extract.
- `src/services/backup/restore.ts` — the §7 orchestration.
- **Reuses:** `worker-control.ts` (stop/restart), the `/reindex` + `/stats` worker endpoints, `paths.ts`, `version.ts`.

## 9. Edition strategy (merges to OSS *and* federation)

This checkout is **OSS** (`master`, no `src/worker/federation/` tree); `federation.json` is referenced nowhere in code here. The feature has **zero federation coupling**, so — like the P3 supersede backport — it is authored once, edition-agnostic, and ports wholesale.

The mechanism that guarantees this: **file selection is an explicit allowlist** (`meta.sqlite3`, `observations.db`, `vector-db/embeddings.db`, `config.json`, `worker.env`), not a denylist. Everything else in `DATA_DIR` — `queue.db`, `logs/`, `*.bak`, sockets, and crucially **`federation.json`** — is excluded simply by not being on the list. No federation symbol is imported or named; the moat-guard stays green. `federation.json` is host/peer identity that should be re-established per host, so excluding it is also correct behavior, not just a coupling dodge. Restore's summary states it was not transferred (no silent omission).

If/when this lands on the federation line, no code changes are required; a federation user who *also* wants peer identity carried over is a separate, explicitly-scoped follow-up.

## 10. Error handling

- **Backup:** write to `<out>.partial` → atomic `rename` (never a half-written archive at the final path). Staging always cleaned. A failed `VACUUM INTO` (e.g. disk full) aborts the whole backup.
- **Restore:** full manifest + checksum validation **before** the worker is stopped or any file is moved. On worker-restart failure after the swap, leave the `.pre-restore-<ts>` copy in place and print explicit rollback instructions. The `.pre-restore` copy is retained (not auto-deleted) so a bad restore is always recoverable.

## 11. Testing

- **Unit:** manifest round-trip; file checksum; the embedder-match decision (match / mismatch / missing identity); `VACUUM INTO` path-escaping; the allowlist (asserts `queue.db`, `federation.json`, `*.bak`, sockets are excluded; durable files included).
- **Integration round-trip:** seed a small temp `DATA_DIR` corpus → `backup create` → wipe → `backup restore` into a fresh `DATA_DIR` → assert counts + a known search hit survive. Plus: (a) mismatched dimension → vectors rebuilt via reindex, search still works; (b) refuse non-empty target without `--force`; (c) corrupted archive → aborts with **zero** on-disk changes; (d) `--no-vectors` archive → restore re-embeds.
- **Cross-platform:** Windows path + `tar.exe` handling and `worker.env` target location (`%APPDATA%\captain-memo`) noted for a manual smoke test, mirroring the existing `WINDOWS_SMOKE_TEST` docs.

## 12. Deferred (the next to-do)

`captain-memo import <FILE>` — merge a backup *into* an existing corpus (dedup, re-key colliding IDs across `documents`/`chunks`/`observations`/vectors). Separate spec + plan. The manifest counts + checksums defined here are exactly what a merge will read; the `backup`-group surface leaves `import` free as a sibling top-level command.
