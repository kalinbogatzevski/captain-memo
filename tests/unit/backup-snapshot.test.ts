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
