# Memory Backup & Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `captain-memo backup create|restore|info` — a portable, turnkey archive of a captain's durable memory + config, so it can seed a new installation or recover a lost one.

**Architecture:** Three thin service modules under `src/services/backup/` (manifest, snapshot/archive, create/restore/info) plus one thin CLI dispatcher `src/cli/commands/backup.ts`. Backup hot-snapshots the live SQLite DBs with `VACUUM INTO` (worker stays up); restore validates checksums first, then stops the worker, swaps files, re-applies config, and rebuilds vectors via `reindex` only when the target embedder differs. File selection is an explicit **allowlist**, so the feature has zero federation coupling and merges to OSS and federation lines unchanged.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `sqlite-vec`, system `tar`, the existing worker `/stats` + `/reindex` HTTP endpoints, `ServiceManager` (systemd / Scheduled Task).

## Global Constraints

- **Runtime:** Bun (`bun:sqlite`, `Bun.spawn`, `Bun.CryptoHasher`). No new npm dependencies.
- **Edition-agnostic:** import no `worker/federation` symbol; select files by allowlist only. Must compile and pass on `master` (OSS) and merge to the federation line unchanged. The moat-guard must stay green.
- **Version source:** import `VERSION` from `src/shared/version.ts` only — never a literal.
- **Paths:** durable data under `DATA_DIR` (`~/.captain-memo`, override `CAPTAIN_MEMO_DATA_DIR`); secrets `worker.env` resolved across `CONFIG_DIR` (`~/.config/captain-memo`, override `CAPTAIN_MEMO_CONFIG_DIR`), `DATA_DIR`, and `/etc/captain-memo` (non-Windows). Resolve these at **call time** (re-read env), not from frozen module consts, so tests can redirect them.
- **Command function convention:** every CLI command is `export async function xCommand(args: string[]): Promise<number>` returning a process exit code (0 ok, non-zero error). Dispatched from the `switch` in `src/cli/index.ts`.
- **Worker service id:** `'captain-memo-worker'`; obtain the supervisor via `getServiceManager()` from `src/services/service-manager/index.ts`.
- **Cross-platform:** `tar` is GNU tar on Linux and `tar.exe` (bsdtar) on Windows 10+ — both accept `-czf/-xzf/-C`. Use forward-relative archive members.
- **Secrets:** archives contain `worker.env` (API keys). `chmod 600` the output and print a loud warning. No encryption in this plan (format reserves room for it).
- **Table names (verified):** `chunks`, `documents` in `meta.sqlite3`; `observations` in `observations.db`; virtual table `vec_chunks` in `vector-db/embeddings.db`.

---

### Task 1: Manifest module

**Files:**
- Create: `src/services/backup/manifest.ts`
- Test: `tests/unit/backup-manifest.test.ts`

**Interfaces:**
- Consumes: `VERSION` from `src/shared/version.ts`; `sha256Hex` from `src/shared/sha.ts` (string hashing — file hashing is added here).
- Produces:
  - `MANIFEST_FORMAT_VERSION: number` (= 1)
  - `interface EmbedderIdentity { provider?: string; model: string; dimension: number; endpoint?: string }`
  - `interface BackupFileEntry { path: string; size: number; sha256: string }`
  - `interface BackupCounts { documents: number; chunks: number; observations: number; vectors: number }`
  - `interface BackupManifest { format_version: number; captain_memo_version: string; created_at: string; platform: string; embedder: EmbedderIdentity; summarizer: { provider?: string; model?: string }; includes_secrets: boolean; includes_vectors: boolean; files: BackupFileEntry[]; counts: BackupCounts }`
  - `function fileSha256(path: string): Promise<string>`
  - `function buildManifest(input: Omit<BackupManifest, 'format_version' | 'captain_memo_version'>): BackupManifest`
  - `function validateManifest(raw: unknown): BackupManifest`
  - `function vectorsCompatible(a: EmbedderIdentity, b: EmbedderIdentity): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/backup-manifest.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  MANIFEST_FORMAT_VERSION, buildManifest, validateManifest,
  vectorsCompatible, fileSha256, type BackupManifest,
} from '../../src/services/backup/manifest.ts';

function sample(): Omit<BackupManifest, 'format_version' | 'captain_memo_version'> {
  return {
    created_at: '2026-06-25T00:00:00.000Z',
    platform: 'linux',
    embedder: { provider: 'voyage-hosted', model: 'voyage-4-lite', dimension: 1024, endpoint: 'http://x' },
    summarizer: { provider: 'claude-oauth', model: 'claude-haiku-4-5' },
    includes_secrets: true,
    includes_vectors: true,
    files: [{ path: 'data/meta.sqlite3', size: 10, sha256: 'abc' }],
    counts: { documents: 1, chunks: 2, observations: 3, vectors: 2 },
  };
}

test('buildManifest stamps format version and app version', () => {
  const m = buildManifest(sample());
  expect(m.format_version).toBe(MANIFEST_FORMAT_VERSION);
  expect(typeof m.captain_memo_version).toBe('string');
  expect(m.captain_memo_version.length).toBeGreaterThan(0);
  expect(m.embedder.model).toBe('voyage-4-lite');
});

test('validateManifest round-trips a built manifest', () => {
  const m = buildManifest(sample());
  const parsed = validateManifest(JSON.parse(JSON.stringify(m)));
  expect(parsed).toEqual(m);
});

test('validateManifest rejects a non-object', () => {
  expect(() => validateManifest(null)).toThrow();
  expect(() => validateManifest('nope')).toThrow();
});

test('validateManifest rejects an unsupported format version', () => {
  const m = buildManifest(sample()) as BackupManifest;
  expect(() => validateManifest({ ...m, format_version: 999 })).toThrow(/format version/i);
});

test('validateManifest rejects a missing embedder model/dimension', () => {
  const m = buildManifest(sample()) as BackupManifest;
  expect(() => validateManifest({ ...m, embedder: { model: 'x' } })).toThrow();
});

test('vectorsCompatible requires same model and dimension', () => {
  const base = { model: 'm', dimension: 1024 };
  expect(vectorsCompatible(base, { model: 'm', dimension: 1024 })).toBe(true);
  expect(vectorsCompatible(base, { model: 'm', dimension: 2048 })).toBe(false);
  expect(vectorsCompatible(base, { model: 'other', dimension: 1024 })).toBe(false);
});

test('fileSha256 hashes file bytes (matches a known value)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-manifest-'));
  const p = join(dir, 'f.bin');
  writeFileSync(p, 'hello');
  // sha256("hello")
  expect(await fileSha256(p)).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/backup-manifest.test.ts`
Expected: FAIL — `Cannot find module '.../src/services/backup/manifest.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/backup/manifest.ts
import { VERSION } from '../../shared/version.ts';

export const MANIFEST_FORMAT_VERSION = 1;

export interface EmbedderIdentity {
  provider?: string;
  model: string;
  dimension: number;
  endpoint?: string;
}
export interface BackupFileEntry { path: string; size: number; sha256: string }
export interface BackupCounts { documents: number; chunks: number; observations: number; vectors: number }

export interface BackupManifest {
  format_version: number;
  captain_memo_version: string;
  created_at: string;            // ISO-8601
  platform: string;              // process.platform
  embedder: EmbedderIdentity;
  summarizer: { provider?: string; model?: string };
  includes_secrets: boolean;
  includes_vectors: boolean;
  files: BackupFileEntry[];
  counts: BackupCounts;
}

/** Stream-hash a file's bytes to a hex sha256 (never buffers the whole file). */
export async function fileSha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}

export function buildManifest(
  input: Omit<BackupManifest, 'format_version' | 'captain_memo_version'>,
): BackupManifest {
  return { format_version: MANIFEST_FORMAT_VERSION, captain_memo_version: VERSION, ...input };
}

/** Parse + shape-check an untrusted manifest. Throws Error with an actionable message. */
export function validateManifest(raw: unknown): BackupManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('manifest.json is not an object');
  const m = raw as Record<string, unknown>;
  if (m.format_version !== MANIFEST_FORMAT_VERSION) {
    throw new Error(
      `unsupported backup format version ${String(m.format_version)} (this build reads ${MANIFEST_FORMAT_VERSION})`,
    );
  }
  const emb = m.embedder as Record<string, unknown> | undefined;
  if (!emb || typeof emb.model !== 'string' || typeof emb.dimension !== 'number') {
    throw new Error('manifest.embedder must carry { model: string, dimension: number }');
  }
  if (!Array.isArray(m.files)) throw new Error('manifest.files must be an array');
  if (typeof m.counts !== 'object' || m.counts === null) throw new Error('manifest.counts missing');
  return m as unknown as BackupManifest;
}

/** Vectors from a backup are reusable only when the target embeds identically. */
export function vectorsCompatible(a: EmbedderIdentity, b: EmbedderIdentity): boolean {
  return a.model === b.model && a.dimension === b.dimension;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/backup-manifest.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/backup/manifest.ts tests/unit/backup-manifest.test.ts
git commit -m "feat(backup): manifest module (build/validate/checksum/vector-compat)"
```

---

### Task 2: Snapshot & archive module

**Files:**
- Create: `src/services/backup/snapshot.ts`
- Test: `tests/unit/backup-snapshot.test.ts`

**Interfaces:**
- Consumes: `Database` from `bun:sqlite`; `sqliteVec` from `sqlite-vec`; `META_DB_PATH`, `OBSERVATIONS_DB_PATH`, `VECTOR_DB_DIR`, `DATA_DIR` from `src/shared/paths.ts`; `validateManifest`, `BackupManifest` from `./manifest.ts`.
- Produces:
  - `interface DurableTarget { archivePath: string; srcPath: string; isVector: boolean }`
  - `function durableTargets(dataDir: string): DurableTarget[]` — the **allowlist** (`data/meta.sqlite3`, `data/observations.db`, `data/vector-db/embeddings.db`).
  - `function hotSnapshot(srcPath: string, destPath: string, opts?: { loadVec?: boolean }): void`
  - `function readVecDimension(embeddingsDbPath: string): number | null`
  - `function readVecCount(embeddingsDbPath: string): number`
  - `function countRows(dbPath: string, sql: string): number` — shared DB-count helper (used by create + restore; defined once here to avoid copy-paste)
  - `function backupStamp(): string` — `YYYYMMDDHHMMSS` wall-clock stamp (shared by the backup filename + the `.pre-restore` dir name)
  - `function createArchive(stagingDir: string, outPath: string): Promise<void>`
  - `function extractArchive(archivePath: string, destDir: string): Promise<void>`
  - `function readManifestFromArchive(archivePath: string): Promise<BackupManifest>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/backup-snapshot.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import {
  durableTargets, hotSnapshot, readVecCount, countRows, backupStamp,
  createArchive, extractArchive, readManifestFromArchive,
} from '../../src/services/backup/snapshot.ts';

test('countRows returns 0 for a missing db and the row count for an existing one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-count-'));
  expect(countRows(join(dir, 'nope.db'), 'SELECT count(*) AS n FROM t')).toBe(0);
  const p = join(dir, 'c.db');
  const db = new Database(p);
  db.exec('CREATE TABLE t(x);'); db.exec('INSERT INTO t VALUES (1),(2);'); db.close();
  expect(countRows(p, 'SELECT count(*) AS n FROM t')).toBe(2);
});

test('backupStamp is a 14-char YYYYMMDDHHMMSS digit string', () => {
  expect(backupStamp()).toMatch(/^\d{14}$/);
});

test('durableTargets is an allowlist of exactly the three durable DBs', () => {
  const t = durableTargets('/tmp/dd');
  expect(t.map((x) => x.archivePath)).toEqual([
    'data/meta.sqlite3', 'data/observations.db', 'data/vector-db/embeddings.db',
  ]);
  // No transient/host files leak in.
  const joined = JSON.stringify(t);
  for (const bad of ['queue.db', 'pending_embed', 'federation.json', '.bak', 'logs']) {
    expect(joined).not.toContain(bad);
  }
});

test('hotSnapshot copies a live WAL db consistently while it stays open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-snap-'));
  const src = join(dir, 'src.db');
  const live = new Database(src);          // simulates the worker holding the db open
  live.exec('PRAGMA journal_mode = WAL;');
  live.exec('CREATE TABLE t(x);');
  live.exec('INSERT INTO t VALUES (1),(2),(3);');
  const dest = join(dir, 'snap.db');
  hotSnapshot(src, dest);                   // src still open
  live.close();
  const snap = new Database(dest, { readonly: true });
  expect((snap.query('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(3);
  snap.close();
  // Snapshot is a single file — no -wal/-shm sidecar required to read it.
  expect(existsSync(dest + '-wal')).toBe(false);
});

test('createArchive + extractArchive round-trips a staging tree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-tar-'));
  const staging = join(dir, 'staging');
  mkdirSync(join(staging, 'data'), { recursive: true });
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify({ ok: 1 }));
  writeFileSync(join(staging, 'data', 'a.txt'), 'hello');
  const out = join(dir, 'b.tar.gz');
  await createArchive(staging, out);
  expect(existsSync(out)).toBe(true);
  const back = join(dir, 'back');
  mkdirSync(back, { recursive: true });
  await extractArchive(out, back);
  expect(await Bun.file(join(back, 'data', 'a.txt')).text()).toBe('hello');
});

test('readManifestFromArchive extracts just the manifest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-man-'));
  const staging = join(dir, 'staging');
  mkdirSync(staging, { recursive: true });
  const manifest = {
    format_version: 1, captain_memo_version: '0.0.0', created_at: 'x', platform: 'linux',
    embedder: { model: 'm', dimension: 1024 }, summarizer: {},
    includes_secrets: false, includes_vectors: false,
    files: [], counts: { documents: 0, chunks: 0, observations: 0, vectors: 0 },
  };
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest));
  const out = join(dir, 'c.tar.gz');
  await createArchive(staging, out);
  const got = await readManifestFromArchive(out);
  expect(got.embedder.model).toBe('m');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/backup-snapshot.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/backup/snapshot.ts
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { existsSync } from 'fs';
import { join } from 'path';
import { validateManifest, type BackupManifest } from './manifest.ts';

export interface DurableTarget { archivePath: string; srcPath: string; isVector: boolean }

/** The backup ALLOWLIST. Anything not named here (queue.db, pending_embed.db,
 *  logs/, federation.json, *.bak, sockets) is excluded by construction — which is
 *  also what keeps the feature free of any federation coupling. */
export function durableTargets(dataDir: string): DurableTarget[] {
  return [
    { archivePath: 'data/meta.sqlite3',            srcPath: join(dataDir, 'meta.sqlite3'),               isVector: false },
    { archivePath: 'data/observations.db',         srcPath: join(dataDir, 'observations.db'),            isVector: false },
    { archivePath: 'data/vector-db/embeddings.db', srcPath: join(dataDir, 'vector-db', 'embeddings.db'), isVector: true  },
  ];
}

/** SQLite string-literal escaping: double every single quote. */
function sqlLiteral(s: string): string { return `'${s.replace(/'/g, "''")}'`; }

/** Consistent hot copy of a live WAL database into a single dest file via
 *  `VACUUM INTO`. The worker may keep writing; we read the last committed state.
 *  For the vector db the sqlite-vec extension MUST be loaded first, or VACUUM
 *  cannot recreate the vec0 virtual table ("no such module: vec0"). */
export function hotSnapshot(srcPath: string, destPath: string, opts: { loadVec?: boolean } = {}): void {
  const db = new Database(srcPath);
  try {
    if (opts.loadVec) sqliteVec.load(db);
    db.exec(`VACUUM INTO ${sqlLiteral(destPath)}`);
  } finally {
    db.close();
  }
}

/** Authoritative embedding dimension = what the stored vectors actually are,
 *  parsed from the vec_chunks declaration `embedding FLOAT[N]`. null if absent. */
export function readVecDimension(embeddingsDbPath: string): number | null {
  const db = new Database(embeddingsDbPath, { readonly: true });
  try {
    sqliteVec.load(db);
    const row = db.query(
      "SELECT sql FROM sqlite_master WHERE name = 'vec_chunks'",
    ).get() as { sql: string } | undefined;
    if (!row?.sql) return null;
    const m = row.sql.match(/FLOAT\s*\[\s*(\d+)\s*\]/i);
    return m ? Number(m[1]) : null;
  } finally {
    db.close();
  }
}

export function readVecCount(embeddingsDbPath: string): number {
  const db = new Database(embeddingsDbPath, { readonly: true });
  try {
    sqliteVec.load(db);
    return (db.query('SELECT count(*) AS n FROM vec_chunks').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Single-row COUNT(*) helper. Returns 0 when the db file is absent so callers
 *  need not branch on existence. Shared by create + restore (no copy-paste). */
export function countRows(dbPath: string, sql: string): number {
  if (!existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true });
  try { return (db.query(sql).get() as { n: number }).n; } finally { db.close(); }
}

/** YYYYMMDDHHMMSS wall-clock stamp for archive + .pre-restore names. */
export function backupStamp(): string {
  return new Date().toISOString().replace(/[:T]/g, '').replace(/\..+$/, '').slice(0, 15);
}

async function runTar(args: string[]): Promise<void> {
  const proc = Bun.spawn(['tar', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`tar ${args.join(' ')} failed (exit ${code}): ${err.trim()}`);
  }
}

/** gzip-tar the staging dir's CONTENTS (relative members) into outPath. */
export async function createArchive(stagingDir: string, outPath: string): Promise<void> {
  await runTar(['-czf', outPath, '-C', stagingDir, '.']);
}

export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  await runTar(['-xzf', archivePath, '-C', destDir]);
}

/** Stream just manifest.json out of the archive to stdout and validate it. */
export async function readManifestFromArchive(archivePath: string): Promise<BackupManifest> {
  const proc = Bun.spawn(['tar', '-xzOf', archivePath, './manifest.json'], { stdout: 'pipe', stderr: 'pipe' });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0 || !text.trim()) {
    // Some tars store the member without the leading "./" — retry that spelling.
    const p2 = Bun.spawn(['tar', '-xzOf', archivePath, 'manifest.json'], { stdout: 'pipe', stderr: 'pipe' });
    const t2 = await new Response(p2.stdout).text();
    if ((await p2.exited) !== 0 || !t2.trim()) throw new Error('archive has no readable manifest.json');
    return validateManifest(JSON.parse(t2));
  }
  return validateManifest(JSON.parse(text));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/backup-snapshot.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/backup/snapshot.ts tests/unit/backup-snapshot.test.ts
git commit -m "feat(backup): hot-snapshot (VACUUM INTO) + tar archive + vec dimension/count readers"
```

---

### Task 3: `createBackup` service

**Files:**
- Create: `src/services/backup/create.ts`
- Test: `tests/integration/backup-create.test.ts`

**Interfaces:**
- Consumes: `durableTargets`, `hotSnapshot`, `readVecDimension`, `readVecCount`, `createArchive`, `countRows`, `backupStamp` from `./snapshot.ts`; `buildManifest`, `fileSha256`, `type BackupManifest`, `type BackupFileEntry`, `type EmbedderIdentity` from `./manifest.ts`; `workerGetOptional` from `../../cli/client.ts`; `DEFAULT_VOYAGE_ENDPOINT` from `../../shared/paths.ts`.
- Produces:
  - `interface CreateBackupOptions { outPath?: string; includeVectors?: boolean }`
  - `interface CreateBackupResult { outPath: string; sizeBytes: number; manifest: BackupManifest; secretsIncluded: boolean }`
  - `function createBackup(opts?: CreateBackupOptions): Promise<CreateBackupResult>`
  - `function resolveDataDir(): string` / `function resolveConfigDir(): string` / `function effectiveWorkerEnv(): string | null` (call-time env resolution — also reused by restore)

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/backup-create.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { createBackup } from '../../src/services/backup/create.ts';
import { readManifestFromArchive, extractArchive } from '../../src/services/backup/snapshot.ts';

let dataDir: string, configDir: string, outDir: string;
let prevData: string | undefined, prevConfig: string | undefined;

function seedCorpus(dir: string) {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'vector-db'), { recursive: true });
  // meta.sqlite3 with 1 document + 2 chunks
  const meta = new Database(join(dir, 'meta.sqlite3'));
  meta.exec('PRAGMA journal_mode = WAL;');
  meta.exec('CREATE TABLE documents(id INTEGER PRIMARY KEY);');
  meta.exec('CREATE TABLE chunks(id INTEGER PRIMARY KEY, text TEXT);');
  meta.exec("INSERT INTO documents(id) VALUES (1);");
  meta.exec("INSERT INTO chunks(text) VALUES ('a'),('b');");
  meta.close();
  // observations.db with 3 rows
  const obs = new Database(join(dir, 'observations.db'));
  obs.exec('PRAGMA journal_mode = WAL;');
  obs.exec('CREATE TABLE observations(id INTEGER PRIMARY KEY);');
  obs.exec('INSERT INTO observations(id) VALUES (1),(2),(3);');
  obs.close();
  // a transient db that must NOT be in the archive
  const q = new Database(join(dir, 'queue.db'));
  q.exec('CREATE TABLE q(x);'); q.close();
  writeFileSync(join(dir, 'federation.json'), '{"peer":"secret"}');
}

beforeEach(() => {
  prevData = process.env.CAPTAIN_MEMO_DATA_DIR;
  prevConfig = process.env.CAPTAIN_MEMO_CONFIG_DIR;
  const root = mkdtempSync(join(tmpdir(), 'cm-backup-'));
  dataDir = join(root, 'data'); configDir = join(root, 'config'); outDir = join(root, 'out');
  mkdirSync(configDir, { recursive: true }); mkdirSync(outDir, { recursive: true });
  process.env.CAPTAIN_MEMO_DATA_DIR = dataDir;
  process.env.CAPTAIN_MEMO_CONFIG_DIR = configDir;
  writeFileSync(join(configDir, 'worker.env'), 'ANTHROPIC_API_KEY=sk-test\n');
  seedCorpus(dataDir);
});
afterEach(() => {
  if (prevData === undefined) delete process.env.CAPTAIN_MEMO_DATA_DIR; else process.env.CAPTAIN_MEMO_DATA_DIR = prevData;
  if (prevConfig === undefined) delete process.env.CAPTAIN_MEMO_CONFIG_DIR; else process.env.CAPTAIN_MEMO_CONFIG_DIR = prevConfig;
});

test('createBackup writes an archive with correct counts and durable files only', async () => {
  const out = join(outDir, 'b.tar.gz');
  const res = await createBackup({ outPath: out, includeVectors: false });
  expect(existsSync(out)).toBe(true);
  expect(res.manifest.counts.chunks).toBe(2);
  expect(res.manifest.counts.observations).toBe(3);
  expect(res.manifest.includes_secrets).toBe(true);
  expect(res.manifest.includes_vectors).toBe(false);
  // chmod 600 on POSIX
  if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o600);

  const back = join(outDir, 'back'); mkdirSync(back, { recursive: true });
  await extractArchive(out, back);
  expect(existsSync(join(back, 'data', 'meta.sqlite3'))).toBe(true);
  expect(existsSync(join(back, 'data', 'observations.db'))).toBe(true);
  expect(existsSync(join(back, 'config', 'worker.env'))).toBe(true);
  // Excluded:
  expect(existsSync(join(back, 'data', 'queue.db'))).toBe(false);
  expect(existsSync(join(back, 'data', 'federation.json'))).toBe(false);

  const man = await readManifestFromArchive(out);
  expect(man.captain_memo_version.length).toBeGreaterThan(0);
});

test('createBackup leaves no .partial file behind on success', async () => {
  const out = join(outDir, 'c.tar.gz');
  await createBackup({ outPath: out, includeVectors: false });
  expect(existsSync(out + '.partial')).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/backup-create.test.ts`
Expected: FAIL — `Cannot find module '.../create.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/backup/create.ts
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, renameSync, chmodSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import {
  durableTargets, hotSnapshot, readVecDimension, readVecCount, createArchive, countRows, backupStamp,
} from './snapshot.ts';
import {
  buildManifest, fileSha256,
  type BackupManifest, type BackupFileEntry, type EmbedderIdentity,
} from './manifest.ts';
import { workerGetOptional } from '../../cli/client.ts';
import { DEFAULT_VOYAGE_ENDPOINT } from '../../shared/paths.ts';

export interface CreateBackupOptions { outPath?: string; includeVectors?: boolean }
export interface CreateBackupResult {
  outPath: string; sizeBytes: number; manifest: BackupManifest; secretsIncluded: boolean;
}

/** Call-time env resolution so tests can redirect DATA_DIR / CONFIG_DIR. */
export function resolveDataDir(): string {
  return process.env.CAPTAIN_MEMO_DATA_DIR ?? join(homedir(), '.captain-memo');
}
export function resolveConfigDir(): string {
  if (process.env.CAPTAIN_MEMO_CONFIG_DIR) return process.env.CAPTAIN_MEMO_CONFIG_DIR;
  return process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'captain-memo')
    : join(homedir(), '.config', 'captain-memo');
}
/** First existing worker.env across CONFIG_DIR, DATA_DIR, then /etc (non-Windows). */
export function effectiveWorkerEnv(): string | null {
  const candidates = [
    join(resolveConfigDir(), 'worker.env'),
    join(resolveDataDir(), 'worker.env'),
  ];
  if (process.platform !== 'win32') candidates.push('/etc/captain-memo/worker.env');
  return candidates.find((p) => existsSync(p)) ?? null;
}

function isoNow(): string { return new Date().toISOString(); }

async function resolveEmbedder(vecDbPath: string, includeVectors: boolean): Promise<EmbedderIdentity> {
  const stats = (await workerGetOptional('/stats')) as
    { embedder?: { model?: string; endpoint?: string } } | null;
  const model = stats?.embedder?.model
    ?? process.env.CAPTAIN_MEMO_EMBEDDER_MODEL ?? 'voyageai/voyage-4-nano';
  const endpoint = stats?.embedder?.endpoint
    ?? process.env.CAPTAIN_MEMO_EMBEDDER_ENDPOINT ?? DEFAULT_VOYAGE_ENDPOINT;
  const dimFromVecs = (includeVectors && existsSync(vecDbPath)) ? readVecDimension(vecDbPath) : null;
  const dimension = dimFromVecs ?? Number(process.env.CAPTAIN_MEMO_EMBEDDING_DIM ?? 2048);
  return { provider: process.env.CAPTAIN_MEMO_EMBEDDER_PROVIDER, model, dimension, endpoint };
}

export async function createBackup(opts: CreateBackupOptions = {}): Promise<CreateBackupResult> {
  const includeVectors = opts.includeVectors ?? true;
  const dataDir = resolveDataDir();
  const outPath = opts.outPath ?? join(process.cwd(), `captain-memo-backup-${backupStamp()}.tar.gz`);
  const partial = outPath + '.partial';

  const staging = mkdtempSync(join(tmpdir(), 'cm-backup-stage-'));
  try {
    mkdirSync(join(staging, 'data', 'vector-db'), { recursive: true });
    mkdirSync(join(staging, 'config'), { recursive: true });

    const files: BackupFileEntry[] = [];
    const addFile = async (rel: string, abs: string) => {
      files.push({ path: rel, size: statSync(abs).size, sha256: await fileSha256(abs) });
    };

    // 1. hot-snapshot the durable DBs (allowlist).
    for (const t of durableTargets(dataDir)) {
      if (t.isVector && !includeVectors) continue;
      if (!existsSync(t.srcPath)) continue;
      const dest = join(staging, t.archivePath);
      mkdirSync(join(dest, '..'), { recursive: true });
      hotSnapshot(t.srcPath, dest, { loadVec: t.isVector });
      await addFile(t.archivePath, dest);
    }

    // 2. config.json (if present) + the effective worker.env (secrets).
    const configJson = join(dataDir, 'config.json');
    if (existsSync(configJson)) {
      copyFileSync(configJson, join(staging, 'config', 'config.json'));
      await addFile('config/config.json', join(staging, 'config', 'config.json'));
    }
    const workerEnv = effectiveWorkerEnv();
    let secretsIncluded = false;
    if (workerEnv) {
      copyFileSync(workerEnv, join(staging, 'config', 'worker.env'));
      await addFile('config/worker.env', join(staging, 'config', 'worker.env'));
      secretsIncluded = true;
    }

    // 3. identity + counts (direct from DBs → exact, works worker-down).
    const vecDbPath = join(dataDir, 'vector-db', 'embeddings.db');
    const manifest = buildManifest({
      created_at: isoNow(),
      platform: process.platform,
      embedder: await resolveEmbedder(vecDbPath, includeVectors),
      summarizer: {
        provider: process.env.CAPTAIN_MEMO_SUMMARIZER_PROVIDER,
        model: process.env.CAPTAIN_MEMO_SUMMARIZER_MODEL,
      },
      includes_secrets: secretsIncluded,
      includes_vectors: includeVectors && existsSync(vecDbPath),
      files,
      counts: {
        documents: countRows(join(dataDir, 'meta.sqlite3'), 'SELECT count(*) AS n FROM documents'),
        chunks: countRows(join(dataDir, 'meta.sqlite3'), 'SELECT count(*) AS n FROM chunks'),
        observations: countRows(join(dataDir, 'observations.db'), 'SELECT count(*) AS n FROM observations'),
        vectors: (includeVectors && existsSync(vecDbPath)) ? readVecCount(vecDbPath) : 0,
      },
    });
    await Bun.write(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // 4. archive → atomic rename → lock down (contains secrets).
    if (existsSync(partial)) rmSync(partial);
    await createArchive(staging, partial);
    renameSync(partial, outPath);
    if (process.platform !== 'win32') chmodSync(outPath, 0o600);

    return { outPath, sizeBytes: statSync(outPath).size, manifest, secretsIncluded };
  } catch (err) {
    if (existsSync(partial)) { try { rmSync(partial); } catch { /* best-effort */ } }
    throw err;
  } finally {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/integration/backup-create.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/backup/create.ts tests/integration/backup-create.test.ts
git commit -m "feat(backup): createBackup — staging, snapshot, secrets, manifest, atomic archive"
```

---

### Task 4: `readBackupInfo` service

**Files:**
- Create: `src/services/backup/info.ts`
- Test: `tests/unit/backup-info.test.ts`

**Interfaces:**
- Consumes: `readManifestFromArchive` from `./snapshot.ts`; `type BackupManifest` from `./manifest.ts`.
- Produces:
  - `function readBackupInfo(archivePath: string): Promise<BackupManifest>`
  - `function formatBackupInfo(m: BackupManifest): string` — human summary lines.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/backup-info.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createArchive } from '../../src/services/backup/snapshot.ts';
import { readBackupInfo, formatBackupInfo } from '../../src/services/backup/info.ts';

async function archiveWith(manifest: unknown): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cm-info-'));
  const staging = join(dir, 's'); mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest));
  const out = join(dir, 'a.tar.gz');
  await createArchive(staging, out);
  return out;
}

test('readBackupInfo returns the manifest and formatBackupInfo summarizes it', async () => {
  const out = await archiveWith({
    format_version: 1, captain_memo_version: '0.13.1', created_at: '2026-06-25T10:00:00.000Z',
    platform: 'linux', embedder: { model: 'voyage-4-lite', dimension: 1024 }, summarizer: {},
    includes_secrets: true, includes_vectors: true, files: [],
    counts: { documents: 4, chunks: 9, observations: 7, vectors: 9 },
  });
  const m = await readBackupInfo(out);
  expect(m.counts.chunks).toBe(9);
  const text = formatBackupInfo(m);
  expect(text).toContain('voyage-4-lite');
  expect(text).toContain('1024');
  expect(text).toMatch(/secrets/i);
  expect(text).toContain('0.13.1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/backup-info.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/backup/info.ts
import { readManifestFromArchive } from './snapshot.ts';
import type { BackupManifest } from './manifest.ts';

export async function readBackupInfo(archivePath: string): Promise<BackupManifest> {
  return readManifestFromArchive(archivePath);
}

export function formatBackupInfo(m: BackupManifest): string {
  const e = m.embedder;
  return [
    `Captain Memo backup (format v${m.format_version})`,
    `  created:     ${m.created_at}  on ${m.platform}`,
    `  app version: ${m.captain_memo_version}`,
    `  embedder:    ${e.model}  dim=${e.dimension}${e.endpoint ? `  (${e.endpoint})` : ''}`,
    `  counts:      ${m.counts.documents} docs · ${m.counts.chunks} chunks · ` +
      `${m.counts.observations} observations · ${m.counts.vectors} vectors`,
    `  vectors:     ${m.includes_vectors ? 'included' : 'not included (restore re-embeds)'}`,
    `  secrets:     ${m.includes_secrets ? 'INCLUDED (worker.env — contains API keys)' : 'not included'}`,
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/backup-info.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/services/backup/info.ts tests/unit/backup-info.test.ts
git commit -m "feat(backup): backup info reader + human summary"
```

---

### Task 5: `restoreBackup` service

**Files:**
- Create: `src/services/backup/restore.ts`
- Test: `tests/integration/backup-restore.test.ts`

**Interfaces:**
- Consumes: `extractArchive`, `readManifestFromArchive`, `readVecDimension`, `countRows`, `backupStamp` from `./snapshot.ts`; `fileSha256`, `vectorsCompatible`, `type BackupManifest`, `type EmbedderIdentity` from `./manifest.ts`; `resolveDataDir`, `resolveConfigDir` from `./create.ts`; `getServiceManager` from `../service-manager/index.ts`; `workerPost`, `workerGetOptional` from `../../cli/client.ts`.
- Produces:
  - `interface RestoreOptions { force?: boolean; reindex?: boolean; startWorker?: boolean }`
  - `interface RestoreResult { restored: BackupManifest; vectorsRebuilt: boolean; preRestoreDir: string | null; counts: { chunks: number; observations: number } }`
  - `function restoreBackup(archivePath: string, opts?: RestoreOptions): Promise<RestoreResult>`
  - `class RestoreError extends Error` (thrown for the refuse-non-empty and integrity-failure cases so the CLI can map exit codes).

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/backup-restore.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { createBackup } from '../../src/services/backup/create.ts';
import { restoreBackup, RestoreError } from '../../src/services/backup/restore.ts';

let root: string, dataDir: string, configDir: string, outDir: string;
let prevData: string | undefined, prevConfig: string | undefined;

function seedCorpus(dir: string, chunks: number, obs: number) {
  mkdirSync(dir, { recursive: true });
  const meta = new Database(join(dir, 'meta.sqlite3'));
  meta.exec('PRAGMA journal_mode = WAL;');
  meta.exec('CREATE TABLE documents(id INTEGER PRIMARY KEY);');
  meta.exec('CREATE TABLE chunks(id INTEGER PRIMARY KEY, text TEXT);');
  for (let i = 0; i < chunks; i++) meta.exec("INSERT INTO chunks(text) VALUES ('x');");
  meta.close();
  const o = new Database(join(dir, 'observations.db'));
  o.exec('PRAGMA journal_mode = WAL;');
  o.exec('CREATE TABLE observations(id INTEGER PRIMARY KEY);');
  for (let i = 0; i < obs; i++) o.exec('INSERT INTO observations(id) VALUES (NULL);');
  o.close();
}

beforeEach(() => {
  prevData = process.env.CAPTAIN_MEMO_DATA_DIR;
  prevConfig = process.env.CAPTAIN_MEMO_CONFIG_DIR;
  root = mkdtempSync(join(tmpdir(), 'cm-restore-'));
  outDir = join(root, 'out'); mkdirSync(outDir, { recursive: true });
});
afterEach(() => {
  if (prevData === undefined) delete process.env.CAPTAIN_MEMO_DATA_DIR; else process.env.CAPTAIN_MEMO_DATA_DIR = prevData;
  if (prevConfig === undefined) delete process.env.CAPTAIN_MEMO_CONFIG_DIR; else process.env.CAPTAIN_MEMO_CONFIG_DIR = prevConfig;
});

function useDataDir(name: string) {
  dataDir = join(root, name); configDir = join(root, name + '-cfg');
  mkdirSync(configDir, { recursive: true });
  process.env.CAPTAIN_MEMO_DATA_DIR = dataDir;
  process.env.CAPTAIN_MEMO_CONFIG_DIR = configDir;
}

test('round-trip: backup a corpus, restore into an empty install, counts survive', async () => {
  useDataDir('src');
  writeFileSync(join(configDir, 'worker.env'), 'ANTHROPIC_API_KEY=sk\n');
  seedCorpus(dataDir, 5, 4);
  const out = join(outDir, 'b.tar.gz');
  await createBackup({ outPath: out, includeVectors: false });

  useDataDir('dst');                          // fresh empty install
  const res = await restoreBackup(out, { startWorker: false });
  expect(res.counts.chunks).toBe(5);
  expect(res.counts.observations).toBe(4);
  expect(existsSync(join(dataDir, 'meta.sqlite3'))).toBe(true);
  expect(existsSync(join(configDir, 'worker.env'))).toBe(true);
});

test('refuses a non-empty target without force, then a pre-restore copy is kept with force', async () => {
  useDataDir('src2');
  seedCorpus(dataDir, 3, 0);
  const out = join(outDir, 'c.tar.gz');
  await createBackup({ outPath: out, includeVectors: false });

  useDataDir('dst2');
  seedCorpus(dataDir, 99, 0);                 // already populated
  await expect(restoreBackup(out, { startWorker: false })).rejects.toBeInstanceOf(RestoreError);

  const res = await restoreBackup(out, { force: true, startWorker: false });
  expect(res.counts.chunks).toBe(3);          // replaced
  expect(res.preRestoreDir).not.toBeNull();
  expect(existsSync(join(res.preRestoreDir!, 'meta.sqlite3'))).toBe(true); // old corpus recoverable
});

test('a corrupted archive aborts with zero changes to the target', async () => {
  useDataDir('dst3');
  seedCorpus(dataDir, 7, 0);
  const bad = join(outDir, 'bad.tar.gz');
  writeFileSync(bad, 'not a real archive');
  await expect(restoreBackup(bad, { force: true, startWorker: false })).rejects.toThrow();
  // untouched
  const meta = new Database(join(dataDir, 'meta.sqlite3'), { readonly: true });
  expect((meta.query('SELECT count(*) AS n FROM chunks').get() as { n: number }).n).toBe(7);
  meta.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/backup-restore.test.ts`
Expected: FAIL — `Cannot find module '.../restore.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/backup/restore.ts
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, copyFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractArchive, readManifestFromArchive, readVecDimension, countRows, backupStamp,
} from './snapshot.ts';
import { fileSha256, vectorsCompatible, type BackupManifest, type EmbedderIdentity } from './manifest.ts';
import { resolveDataDir, resolveConfigDir } from './create.ts';
import { getServiceManager } from '../service-manager/index.ts';
import { workerPost, workerGetOptional } from '../../cli/client.ts';
import { DEFAULT_WORKER_PORT } from '../../shared/paths.ts';

const WORKER_SERVICE = 'captain-memo-worker';

export class RestoreError extends Error {}

export interface RestoreOptions { force?: boolean; reindex?: boolean; startWorker?: boolean }
export interface RestoreResult {
  restored: BackupManifest;
  vectorsRebuilt: boolean;
  preRestoreDir: string | null;
  counts: { chunks: number; observations: number };
}

const DURABLE_NAMES = ['meta.sqlite3', 'observations.db'];

function targetIsNonEmpty(dataDir: string): boolean {
  return existsSync(join(dataDir, 'meta.sqlite3'))
    || existsSync(join(dataDir, 'observations.db'))
    || existsSync(join(dataDir, 'vector-db', 'embeddings.db'));
}

/** The target install's CURRENT embedder identity (for the vector decision). */
async function targetEmbedder(dataDir: string): Promise<EmbedderIdentity> {
  const stats = (await workerGetOptional('/stats')) as { embedder?: { model?: string } } | null;
  const model = stats?.embedder?.model
    ?? process.env.CAPTAIN_MEMO_EMBEDDER_MODEL ?? 'voyageai/voyage-4-nano';
  const vecDb = join(dataDir, 'vector-db', 'embeddings.db');
  const dimension = (existsSync(vecDb) ? readVecDimension(vecDb) : null)
    ?? Number(process.env.CAPTAIN_MEMO_EMBEDDING_DIM ?? 2048);
  return { model, dimension };
}

export async function restoreBackup(archivePath: string, opts: RestoreOptions = {}): Promise<RestoreResult> {
  const startWorker = opts.startWorker ?? true;
  const dataDir = resolveDataDir();
  const configDir = resolveConfigDir();

  // ── Phase A: validate everything BEFORE touching the target ──
  const tmp = mkdtempSync(join(tmpdir(), 'cm-restore-stage-'));
  try {
    await extractArchive(archivePath, tmp);                     // throws on a non-archive
    const manifest = await readManifestFromArchive(archivePath);
    for (const f of manifest.files) {
      const abs = join(tmp, f.path);
      if (!existsSync(abs)) throw new RestoreError(`archive missing listed file: ${f.path}`);
      if ((await fileSha256(abs)) !== f.sha256) throw new RestoreError(`checksum mismatch: ${f.path}`);
    }

    if (targetIsNonEmpty(dataDir) && !opts.force) {
      throw new RestoreError(
        'Target already has memories. Re-run with --force to replace them ' +
        '(the existing corpus is moved aside to a recoverable .pre-restore-* dir).',
      );
    }

    // ── Phase B: mutate the target (worker down) ──
    const sm = getServiceManager();
    if (startWorker) { try { await sm.stop(WORKER_SERVICE, { graceful: true, port: DEFAULT_WORKER_PORT }); } catch { /* may be down */ } }

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    // Move current durable files aside (recoverable rollback).
    let preRestoreDir: string | null = null;
    if (targetIsNonEmpty(dataDir)) {
      preRestoreDir = join(dataDir, `.pre-restore-${backupStamp()}`);
      mkdirSync(preRestoreDir, { recursive: true });
      for (const n of DURABLE_NAMES) moveIfExists(join(dataDir, n), join(preRestoreDir, n));
      if (existsSync(join(dataDir, 'vector-db'))) moveIfExists(join(dataDir, 'vector-db'), join(preRestoreDir, 'vector-db'));
      // Drop stale WAL sidecars of the replaced DBs.
      for (const n of DURABLE_NAMES) for (const s of ['-wal', '-shm']) rmIfExists(join(dataDir, n + s));
    }

    // Copy restored durable DBs into place.
    moveIfExists(join(tmp, 'data', 'meta.sqlite3'), join(dataDir, 'meta.sqlite3'));
    moveIfExists(join(tmp, 'data', 'observations.db'), join(dataDir, 'observations.db'));
    const restoredVec = join(tmp, 'data', 'vector-db', 'embeddings.db');
    const hasVec = existsSync(restoredVec);

    // Apply config + secrets.
    if (existsSync(join(tmp, 'config', 'config.json'))) copyFileSync(join(tmp, 'config', 'config.json'), join(dataDir, 'config.json'));
    if (existsSync(join(tmp, 'config', 'worker.env'))) copyFileSync(join(tmp, 'config', 'worker.env'), join(configDir, 'worker.env'));

    // Vector decision: keep restored vectors only if the target embeds identically.
    let vectorsRebuilt = false;
    const compatible = hasVec && manifest.includes_vectors
      && vectorsCompatible(manifest.embedder, await targetEmbedder(dataDir));
    mkdirSync(join(dataDir, 'vector-db'), { recursive: true });
    if (compatible && !opts.reindex) {
      moveIfExists(restoredVec, join(dataDir, 'vector-db', 'embeddings.db'));
    } else {
      // Drop any stale vectors → they are rebuilt from chunk text + observations.
      rmIfExists(join(dataDir, 'vector-db', 'embeddings.db'));
      vectorsRebuilt = true;
    }

    // ── Phase C: bring the worker back; rebuild vectors if needed ──
    if (startWorker) {
      await sm.start(WORKER_SERVICE);
      if (vectorsRebuilt) {
        try { await workerPost('/reindex', { channel: 'all', force: true }); } catch { /* surfaced by caller */ }
      }
    }

    return {
      restored: manifest,
      vectorsRebuilt,
      preRestoreDir,
      counts: {
        chunks: countRows(join(dataDir, 'meta.sqlite3'), 'SELECT count(*) AS n FROM chunks'),
        observations: countRows(join(dataDir, 'observations.db'), 'SELECT count(*) AS n FROM observations'),
      },
    };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function moveIfExists(from: string, to: string): void {
  if (!existsSync(from)) return;
  mkdirSync(join(to, '..'), { recursive: true });
  renameSync(from, to);
}
function rmIfExists(p: string): void { if (existsSync(p)) { try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } } }
```

> **Note on `renameSync` across filesystems:** the temp staging dir and `DATA_DIR` can be on different filesystems (`EXDEV`). If CI surfaces `EXDEV`, change `moveIfExists` to `copyFileSync` + `rmSync` for files and a recursive copy for `vector-db`. Keep `renameSync` for the same-filesystem `.pre-restore` move.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/integration/backup-restore.test.ts`
Expected: PASS (3 tests). If `EXDEV` appears, apply the cross-filesystem note above and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/services/backup/restore.ts tests/integration/backup-restore.test.ts
git commit -m "feat(backup): restoreBackup — validate-before-touch, swap, vector decision, reindex"
```

---

### Task 6: CLI command + dispatch + help + docs

**Files:**
- Create: `src/cli/commands/backup.ts`
- Modify: `src/cli/index.ts` (import + `switch` case + `HELP` text)
- Modify: `README.md` (add a "Backup & restore" subsection)
- Test: `tests/integration/backup-command.test.ts`

**Interfaces:**
- Consumes: `createBackup` from `../../services/backup/create.ts`; `restoreBackup`, `RestoreError` from `../../services/backup/restore.ts`; `readBackupInfo`, `formatBackupInfo` from `../../services/backup/info.ts`; `fmtBytes` from `../../shared/format.ts`.
- Produces: `function backupCommand(args: string[]): Promise<number>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/backup-command.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { backupCommand } from '../../src/cli/commands/backup.ts';

let root: string, outDir: string;
let prevData: string | undefined, prevConfig: string | undefined;

async function capture(fn: () => Promise<number>): Promise<{ out: string; code: number }> {
  const origLog = console.log, origErr = console.error;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  let code = 0;
  try { code = await fn(); } finally { console.log = origLog; console.error = origErr; }
  return { out: lines.join('\n'), code };
}

function seed(dir: string) {
  mkdirSync(dir, { recursive: true });
  const meta = new Database(join(dir, 'meta.sqlite3'));
  meta.exec('CREATE TABLE documents(id INTEGER PRIMARY KEY);');
  meta.exec('CREATE TABLE chunks(id INTEGER PRIMARY KEY, text TEXT);');
  meta.exec("INSERT INTO chunks(text) VALUES ('a'),('b');");
  meta.close();
  const o = new Database(join(dir, 'observations.db'));
  o.exec('CREATE TABLE observations(id INTEGER PRIMARY KEY);');
  o.close();
}

beforeEach(() => {
  prevData = process.env.CAPTAIN_MEMO_DATA_DIR; prevConfig = process.env.CAPTAIN_MEMO_CONFIG_DIR;
  root = mkdtempSync(join(tmpdir(), 'cm-cmd-'));
  outDir = join(root, 'out'); mkdirSync(outDir, { recursive: true });
  process.env.CAPTAIN_MEMO_DATA_DIR = join(root, 'data');
  process.env.CAPTAIN_MEMO_CONFIG_DIR = join(root, 'cfg');
  mkdirSync(process.env.CAPTAIN_MEMO_CONFIG_DIR, { recursive: true });
  seed(process.env.CAPTAIN_MEMO_DATA_DIR);
});
afterEach(() => {
  if (prevData === undefined) delete process.env.CAPTAIN_MEMO_DATA_DIR; else process.env.CAPTAIN_MEMO_DATA_DIR = prevData;
  if (prevConfig === undefined) delete process.env.CAPTAIN_MEMO_CONFIG_DIR; else process.env.CAPTAIN_MEMO_CONFIG_DIR = prevConfig;
});

test('unknown subcommand prints usage and exits 2', async () => {
  const { out, code } = await capture(() => backupCommand(['frobnicate']));
  expect(code).toBe(2);
  expect(out).toMatch(/create|restore|info/);
});

test('create then info round-trips through the CLI', async () => {
  const out = join(outDir, 'b.tar.gz');
  const c = await capture(() => backupCommand(['create', '--out', out, '--no-vectors']));
  expect(c.code).toBe(0);
  expect(existsSync(out)).toBe(true);
  expect(c.out).toMatch(/API keys|secrets/i);  // the loud warning (worker.env may be absent → still safe)

  const i = await capture(() => backupCommand(['info', out]));
  expect(i.code).toBe(0);
  expect(i.out).toMatch(/chunks/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/backup-command.test.ts`
Expected: FAIL — `Cannot find module '.../commands/backup.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/cli/commands/backup.ts
// `captain-memo backup create|restore|info` — portable memory archive.
import { createBackup } from '../../services/backup/create.ts';
import { restoreBackup, RestoreError } from '../../services/backup/restore.ts';
import { readBackupInfo, formatBackupInfo } from '../../services/backup/info.ts';
import { fmtBytes } from '../../shared/format.ts';

const USAGE = `Usage:
  captain-memo backup create [--out PATH] [--no-vectors]
  captain-memo backup restore <FILE> [--force] [--reindex]
  captain-memo backup info <FILE>`;

export async function backupCommand(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'create':  return backupCreate(rest);
    case 'restore': return backupRestore(rest);
    case 'info':    return backupInfo(rest);
    default:
      console.error(USAGE);
      return 2;
  }
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function backupCreate(args: string[]): Promise<number> {
  const outPath = flagValue(args, '--out');
  const includeVectors = !args.includes('--no-vectors');
  const res = await createBackup({ outPath, includeVectors });
  console.log(`✓ backup written: ${res.outPath}  (${fmtBytes(res.sizeBytes)})`);
  console.log(
    `  ${res.manifest.counts.chunks} chunks · ${res.manifest.counts.observations} observations · ` +
    `${res.manifest.counts.vectors} vectors`,
  );
  if (res.secretsIncluded) {
    console.log('');
    console.log('⚠  This archive CONTAINS API keys (worker.env). Store it securely —');
    console.log('   it is chmod 600, but treat it like a password. Do not commit or share it.');
  }
  return 0;
}

async function backupRestore(args: string[]): Promise<number> {
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error(USAGE); return 2; }
  const force = args.includes('--force');
  const reindex = args.includes('--reindex');
  try {
    const res = await restoreBackup(file, { force, reindex });
    console.log(`✓ restored: ${res.counts.chunks} chunks · ${res.counts.observations} observations`);
    if (res.vectorsRebuilt) console.log('  vectors rebuilt from source (embedder differed or --reindex) — reindex running');
    else console.log('  vectors restored as-is (embedder matched)');
    if (res.preRestoreDir) console.log(`  previous corpus kept at: ${res.preRestoreDir}`);
    console.log('  note: federation/peer identity is not transferred — re-establish it on this host if needed.');
    return 0;
  } catch (err) {
    if (err instanceof RestoreError) { console.error(`✗ ${err.message}`); return 1; }
    throw err;
  }
}

async function backupInfo(args: string[]): Promise<number> {
  const file = args[0];
  if (!file) { console.error(USAGE); return 2; }
  console.log(formatBackupInfo(await readBackupInfo(file)));
  return 0;
}
```

Then wire it into `src/cli/index.ts`. Add the import near the other command imports:

```ts
import { backupCommand } from './commands/backup.ts';
```

Add the case in the `switch (cmd)` block (next to `restore`):

```ts
    case 'backup':
      exit = await backupCommand(args.slice(1));
      break;
```

Add to the `HELP` template's command list (after the `restore` line):

```
  backup       create | restore | info — portable memory archive (move/restore a captain's memories)
```

And add an example under `Examples:`:

```
  captain-memo backup create --out ~/cm-backup.tar.gz
  captain-memo backup restore ~/cm-backup.tar.gz --force
```

- [ ] **Step 4: Run the test + the existing CLI smoke**

Run: `bun test tests/integration/backup-command.test.ts`
Expected: PASS (2 tests).

Run: `bun run bin/captain-memo help`
Expected: output now lists the `backup` command.

- [ ] **Step 5: Add the README subsection**

Add under an appropriate operations heading in `README.md`:

```markdown
### Backup & restore

Move a captain's memories to a new machine, or recover them after a loss:

```bash
captain-memo backup create --out ~/cm-backup.tar.gz   # hot snapshot; worker stays up
captain-memo backup info ~/cm-backup.tar.gz           # inspect without restoring
captain-memo backup restore ~/cm-backup.tar.gz --force # replace the local corpus
```

The archive contains your memory DBs, config, **and `worker.env` (API keys)** — it is
written `chmod 600`; store it securely. On restore, vectors are reused when the target
embedder matches the backup, and otherwise rebuilt from source automatically.
Merging two corpora (`import`) is planned separately.
```

- [ ] **Step 6: Run the full suite + the moat guard**

Run: `bun test`
Expected: PASS (whole suite, including the four new backup test files).

Run: `bash scripts/moat-guard.sh`
Expected: PASS — the backup feature imports no `worker/federation` symbol.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/backup.ts src/cli/index.ts README.md tests/integration/backup-command.test.ts
git commit -m "feat(backup): captain-memo backup create|restore|info CLI + docs"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §1 goal / replace-not-merge | Task 5 (`force` guard), Task 6 (CLI) |
| §2 data model / allowlist | Task 2 (`durableTargets`), verified excludes in Task 3 test |
| §3 command surface `create/restore/info` | Task 6 |
| §4 archive layout `data/` + `config/` + `manifest.json` | Task 3 |
| §5 manifest fields + identity/counts | Task 1 (shape), Task 3 (population) |
| §6 hot snapshot, no downtime, `/stats`-or-offline | Task 2 (`hotSnapshot`), Task 3 (`resolveEmbedder`, direct counts) |
| §7 restore flow (validate→guard→stop→swap→config→vector→start→reindex→verify) | Task 5 |
| §8 components | Tasks 1–6 map 1:1 to the listed files |
| §9 edition strategy / allowlist / moat-guard | Task 2 + Task 6 Step 6 |
| §10 error handling (atomic partial, validate-before-touch, pre-restore kept) | Task 3 (partial/rename), Task 5 (Phase A before B, `.pre-restore`) |
| §11 testing (round-trip, mismatch→reindex, refuse, corrupted, --no-vectors) | Tasks 3 & 5 tests (round-trip, refuse, corrupted, --no-vectors); see gap note |
| §12 deferred `import` | Out of scope by design |

**Gap noted & accepted:** the spec's "mismatched-dimension → vectors rebuilt" case is exercised at the unit level via `vectorsCompatible` (Task 1) and the `vectorsRebuilt` branch is covered by the round-trip test using a `--no-vectors` archive (which forces the rebuild path in Task 5). A full end-to-end *re-embed with a live embedder* is intentionally not automated (it needs a running embedder/worker, like the existing reindex integration tests) and is listed for the manual cross-platform smoke pass. This matches how the repo treats embedder-dependent paths.

**2. Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to Task N". Every code step contains complete, runnable code. The cross-filesystem `EXDEV` note gives the exact fallback code path rather than a vague "handle errors."

**3. Type consistency:** `EmbedderIdentity { model, dimension }` is used identically in Tasks 1/2/3/5. `vectorsCompatible(a, b)` signature matches its callers. `createBackup`/`restoreBackup`/`backupCommand` signatures match their imports. `resolveDataDir`/`resolveConfigDir` are defined in Task 3 and consumed in Task 5. `RestoreError` is thrown in Task 5 and caught in Task 6. `readManifestFromArchive` (Task 2) is consumed by Tasks 4 & 5. Worker endpoints `/stats` (GET) and `/reindex` (POST `{channel:'all', force:true}`) match the verified server shapes.
