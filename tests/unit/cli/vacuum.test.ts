import { test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TMP_DIR = join(tmpdir(), `captain-memo-vacuum-test-${process.pid}`);

beforeAll(() => {
  mkdirSync(join(TMP_DIR, 'vector-db'), { recursive: true });
});

afterAll(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

// Re-run the vacuum logic against a temp data dir. The CLI command pulls
// paths from shared/paths.ts at module-load time, so we exercise the core
// VACUUM behavior directly here rather than going through the env-coupled
// CLI entry point.
function vacuumDb(path: string): { before: number; after: number } {
  const before = statSync(path).size;
  const db = new Database(path);
  try {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* not WAL */ }
    db.exec('VACUUM;');
  } finally {
    db.close();
  }
  const after = statSync(path).size;
  return { before, after };
}

test('VACUUM reclaims pages after a DELETE', () => {
  const path = join(TMP_DIR, 'reclaim.db');
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT);');
  const insert = db.query('INSERT INTO t (blob) VALUES (?)');
  // ~1 MB of data
  const padding = 'x'.repeat(1024);
  for (let i = 0; i < 1024; i++) insert.run(padding);
  db.exec('DELETE FROM t;');
  db.close();

  const { before, after } = vacuumDb(path);
  expect(before).toBeGreaterThan(after);
  // Sanity: after vacuum the file should be small (well under 100 KB for
  // an empty single-table DB)
  expect(after).toBeLessThan(100 * 1024);
});

test('VACUUM is a no-op on an already-compact DB', () => {
  const path = join(TMP_DIR, 'compact.db');
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY);');
  db.close();

  const { before, after } = vacuumDb(path);
  // No data deleted → size shouldn't grow and shouldn't shrink meaningfully
  expect(Math.abs(before - after)).toBeLessThan(64 * 1024);
});

test('VACUUM handles a missing wal_checkpoint pragma gracefully (non-WAL DB)', () => {
  const path = join(TMP_DIR, 'rollback.db');
  const db = new Database(path);
  // Skip the WAL pragma — fall back to rollback journal mode.
  db.exec('PRAGMA journal_mode = DELETE;');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT);');
  const insert = db.query('INSERT INTO t (blob) VALUES (?)');
  for (let i = 0; i < 100; i++) insert.run('x'.repeat(1024));
  db.exec('DELETE FROM t;');
  db.close();

  // Should not throw on the wal_checkpoint pragma; the CLI command swallows
  // the error and still runs VACUUM.
  expect(() => vacuumDb(path)).not.toThrow();
});
