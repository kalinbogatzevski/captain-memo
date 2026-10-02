import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MetaStore } from '../../../src/worker/meta.ts';
import { runMigration, type MigrationDeps } from '../../../src/migration/runner.ts';

let workDir: string;
let claudeMemPath: string;
let metaPath: string;
let store: MetaStore;

const fakeEmbedder = {
  embed: async (texts: string[]) =>
    texts.map(() => Array.from({ length: 8 }, () => 0.1)),
};
const fakeVector = {
  ensureCollection: async () => {},
  add: async () => {},
  delete: async () => {},
  query: async () => [],
};

function seedClaudeMem(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY,
      content_session_id TEXT UNIQUE NOT NULL,
      memory_session_id TEXT UNIQUE,
      project TEXT NOT NULL,
      user_prompt TEXT, started_at TEXT NOT NULL, started_at_epoch INTEGER NOT NULL,
      completed_at TEXT, completed_at_epoch INTEGER,
      status TEXT NOT NULL DEFAULT 'completed'
    );
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY, memory_session_id TEXT NOT NULL, project TEXT NOT NULL,
      text TEXT, type TEXT NOT NULL, title TEXT, subtitle TEXT,
      facts TEXT, narrative TEXT, concepts TEXT,
      files_read TEXT, files_modified TEXT,
      prompt_number INTEGER, discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL
    );
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY, memory_session_id TEXT NOT NULL, project TEXT NOT NULL,
      request TEXT, investigated TEXT, learned TEXT,
      completed TEXT, next_steps TEXT,
      files_read TEXT, files_edited TEXT, notes TEXT,
      prompt_number INTEGER, discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL
    );
  `);
  db.run(
    `INSERT INTO sdk_sessions(content_session_id, memory_session_id, project, started_at, started_at_epoch)
     VALUES ('s1','m1','acme-app','2026-05-01',1730000000)`,
  );
  db.run(
    `INSERT INTO observations(id, memory_session_id, project, type, title, narrative, facts,
                              concepts, files_read, files_modified, prompt_number,
                              created_at, created_at_epoch)
     VALUES (1,'m1','acme-app','discovery','Title','Narrative.',?, ?, ?, ?, 1,'',1730000001000)`,
    [
      JSON.stringify(['fact one', 'fact two']),
      JSON.stringify(['concept']),
      JSON.stringify(['a.php']),
      JSON.stringify([]),
    ],
  );
  db.run(
    `INSERT INTO observations(id, memory_session_id, project, type, title, narrative, facts,
                              concepts, files_read, files_modified, prompt_number,
                              created_at, created_at_epoch)
     VALUES (2,'m1','acme-app','bugfix','T2','',?, ?, ?, ?, 2,'',1730000002000)`,
    [
      JSON.stringify(['only fact']),
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
    ],
  );
  db.run(
    `INSERT INTO session_summaries(id, memory_session_id, project, request,
                                    investigated, learned, completed, next_steps, notes,
                                    prompt_number, created_at, created_at_epoch)
     VALUES (10,'m1','acme-app','req','inv','','done','next','',5,'',1730000005000)`,
  );
  db.close();
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-mig-'));
  claudeMemPath = join(workDir, 'claude-mem.db');
  metaPath = join(workDir, 'meta.sqlite3');
  seedClaudeMem(claudeMemPath);
  store = new MetaStore(metaPath);
});

afterEach(() => {
  store.close();
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

test('runMigration — migrates all observations + summaries', async () => {
  const deps: MigrationDeps = {
    meta: store,
    embedder: fakeEmbedder,
    vector: fakeVector as any,
    collectionName: 'am_test',
    projectId: 'acme-app',
    sourceDbPath: claudeMemPath,
  };
  const result = await runMigration(deps, {});
  expect(result.observations_migrated).toBe(2);
  expect(result.summaries_migrated).toBe(1);
  expect(result.errors).toBe(0);

  const counts = store.migrationCounts();
  expect(counts.observation).toBe(2);
  expect(counts.summary).toBe(1);
});

test('runMigration — re-running is a no-op (idempotent)', async () => {
  const deps: MigrationDeps = {
    meta: store, embedder: fakeEmbedder, vector: fakeVector as any,
    collectionName: 'am_test', projectId: 'acme-app', sourceDbPath: claudeMemPath,
  };
  await runMigration(deps, {});
  const second = await runMigration(deps, {});
  expect(second.observations_migrated).toBe(0);
  expect(second.summaries_migrated).toBe(0);
  expect(second.observations_skipped).toBe(2);
  expect(second.summaries_skipped).toBe(1);
});

test('runMigration — --limit caps total rows processed', async () => {
  const deps: MigrationDeps = {
    meta: store, embedder: fakeEmbedder, vector: fakeVector as any,
    collectionName: 'am_test', projectId: 'acme-app', sourceDbPath: claudeMemPath,
  };
  const result = await runMigration(deps, { limit: 1 });
  expect(result.observations_migrated + result.summaries_migrated).toBe(1);
});

test('runMigration — --dry-run reports without writing', async () => {
  const deps: MigrationDeps = {
    meta: store, embedder: fakeEmbedder, vector: fakeVector as any,
    collectionName: 'am_test', projectId: 'acme-app', sourceDbPath: claudeMemPath,
  };
  const result = await runMigration(deps, { dryRun: true });
  expect(result.observations_migrated).toBe(2);
  expect(result.summaries_migrated).toBe(1);
  // But nothing was actually written
  expect(store.migrationCounts().observation).toBe(0);
  expect(store.migrationCounts().summary).toBe(0);
});

// #226(a): the migration replaced a document's chunks without deleting their vectors, and stored whatever
// the embedder returned, zeros included.
test('runMigration — a re-run of an already written document deletes its old vectors first', async () => {
  const calls: Array<{ kind: 'add' | 'delete'; ids: string[] }> = [];
  const vector = {
    ...fakeVector,
    add: async (_c: string, items: Array<{ id: string }>) => { calls.push({ kind: 'add', ids: items.map(i => i.id) }); },
    delete: async (_c: string, ids: string[]) => { calls.push({ kind: 'delete', ids }); },
  };
  const deps: MigrationDeps = {
    meta: store, embedder: fakeEmbedder, vector: vector as any,
    collectionName: 'am_test', projectId: 'acme-app', sourceDbPath: claudeMemPath,
  };
  await runMigration(deps, {});
  const firstIds = calls.flatMap(c => c.ids);
  expect(calls.every(c => c.kind === 'add')).toBe(true);

  // A run killed between the write and markMigrationDone leaves the documents but no progress rows.
  const raw = new Database(metaPath);
  raw.exec('DELETE FROM migration_progress');
  raw.close();
  calls.length = 0;
  const second = await runMigration(deps, {});
  expect(second.errors).toBe(0);
  expect(calls.filter(c => c.kind === 'delete').flatMap(c => c.ids).sort()).toEqual([...firstIds].sort());
});

test('runMigration — an all-zero embedding is not stored and the row stays unmigrated', async () => {
  let added = 0;
  const deps: MigrationDeps = {
    meta: store,
    embedder: { embed: async (texts: string[]) => texts.map(() => Array.from({ length: 8 }, () => 0)) },
    vector: { ...fakeVector, add: async () => { added++; } } as any,
    collectionName: 'am_test', projectId: 'acme-app', sourceDbPath: claudeMemPath,
  };
  const result = await runMigration(deps, {});
  expect(result.errors).toBe(3);
  expect(result.observations_migrated + result.summaries_migrated).toBe(0);
  expect(added).toBe(0);
  expect(store.migrationCounts().observation).toBe(0);
});
