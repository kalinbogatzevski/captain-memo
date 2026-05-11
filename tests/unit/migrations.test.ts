import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyMigrations, getAppliedVersions } from '../../src/worker/migrations.ts';
import type { Migration } from '../../src/worker/migrations.ts';

let workDir: string;
let db: Database;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-mig-'));
  db = new Database(join(workDir, 'test.db'));
  db.exec('PRAGMA journal_mode = WAL;');
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTableMigration(tableName: string): Migration {
  return {
    version: 1,
    name: 'create_table',
    up: (d) => d.exec(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, val TEXT)`),
  };
}

function countVersions(): number {
  return (db.query('SELECT COUNT(*) AS n FROM schema_versions').get() as { n: number }).n;
}

// ─── tests ───────────────────────────────────────────────────────────────────

test('migrations — fresh DB applies all migrations in order', () => {
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');

  const migrations: Migration[] = [
    { version: 2, name: 'add_col_b', up: (d) => d.exec('ALTER TABLE items ADD COLUMN b TEXT') },
    { version: 1, name: 'add_col_a', up: (d) => d.exec('ALTER TABLE items ADD COLUMN a TEXT') },
  ];

  applyMigrations(db, migrations);

  const rows = getAppliedVersions(db);
  expect(rows).toHaveLength(2);
  expect(rows[0]!.version).toBe(1);
  expect(rows[0]!.name).toBe('add_col_a');
  expect(rows[1]!.version).toBe(2);
  expect(rows[1]!.name).toBe('add_col_b');
  expect(rows[0]!.applied_at_epoch).toBeGreaterThan(0);
});

test('migrations — re-running is a no-op (all already applied)', () => {
  const migrations: Migration[] = [makeTableMigration('things')];

  applyMigrations(db, migrations);
  const countAfterFirst = countVersions();

  // second run — must not insert duplicates or throw
  applyMigrations(db, migrations);
  expect(countVersions()).toBe(countAfterFirst);
});

test('migrations — existing DB with column already present marks applied without re-running', () => {
  // Simulate a DB that already has the column from the old ALTER-with-try-catch era.
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, col_a TEXT)');

  let upCallCount = 0;
  const migrations: Migration[] = [
    {
      version: 1,
      name: 'add_col_a',
      up: (d) => {
        upCallCount++;
        d.exec('ALTER TABLE t ADD COLUMN col_a TEXT'); // will throw duplicate-column
      },
    },
  ];

  applyMigrations(db, migrations);

  // Should be recorded even though up() threw a duplicate-column error.
  expect(countVersions()).toBe(1);
  expect(upCallCount).toBe(1); // up() was called once (then recovered idempotently)

  // Second call — should skip entirely (already in schema_versions).
  applyMigrations(db, migrations);
  expect(upCallCount).toBe(1); // not called again
});

test('migrations — unexpected error does NOT mark applied (retries on next call)', () => {
  const logs: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(' '));

  let callCount = 0;
  const migrations: Migration[] = [
    {
      version: 1,
      name: 'exploding_migration',
      up: () => {
        callCount++;
        throw new Error('disk full or something terrible');
      },
    },
  ];

  // First run — fails.
  applyMigrations(db, migrations);
  expect(countVersions()).toBe(0); // NOT recorded
  expect(callCount).toBe(1);
  expect(logs.some(l => l.includes('UNEXPECTED ERROR'))).toBe(true);

  console.error = origError;

  // Second run — retries the migration (up() is called again).
  applyMigrations(db, migrations);
  expect(callCount).toBe(2);
  expect(countVersions()).toBe(0); // still not recorded (still failing)
});

test('migrations — out-of-order array applies in version order', () => {
  db.exec('CREATE TABLE seq (id INTEGER PRIMARY KEY)');

  const order: number[] = [];
  const migrations: Migration[] = [
    { version: 3, name: 'step_c', up: (d) => { order.push(3); d.exec('ALTER TABLE seq ADD COLUMN c TEXT'); } },
    { version: 1, name: 'step_a', up: (d) => { order.push(1); d.exec('ALTER TABLE seq ADD COLUMN a TEXT'); } },
    { version: 2, name: 'step_b', up: (d) => { order.push(2); d.exec('ALTER TABLE seq ADD COLUMN b TEXT'); } },
  ];

  applyMigrations(db, migrations);
  expect(order).toEqual([1, 2, 3]);
});

test('getAppliedVersions — returns recorded rows sorted by version', () => {
  db.exec('CREATE TABLE x (id INTEGER PRIMARY KEY)');

  const migrations: Migration[] = [
    { version: 1, name: 'first', up: (d) => d.exec('ALTER TABLE x ADD COLUMN a TEXT') },
    { version: 2, name: 'second', up: (d) => d.exec('ALTER TABLE x ADD COLUMN b TEXT') },
  ];
  applyMigrations(db, migrations);

  const rows = getAppliedVersions(db);
  expect(rows).toHaveLength(2);
  expect(rows.map(r => r.version)).toEqual([1, 2]);
  expect(rows.map(r => r.name)).toEqual(['first', 'second']);
});

test('getAppliedVersions — returns empty array when table does not exist', () => {
  // Fresh DB with no applyMigrations call.
  expect(getAppliedVersions(db)).toEqual([]);
});
