import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MetaStore } from '../../src/worker/meta.ts';
import { VectorStore } from '../../src/worker/vector-store.ts';
import { runMigration } from '../../src/migration/runner.ts';

let workDir: string;
let metaPath: string;
let vectorPath: string;
let claudeMemPath: string;
let meta: MetaStore;
let vector: VectorStore;

const fixtureSrc = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/claude-mem-mini/claude-mem-fixture.db',
);

const fakeEmbedder = {
  embed: async (texts: string[]) =>
    texts.map(() => new Array(1024).fill(0)),
};

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-mig-e2e-'));
  metaPath = join(workDir, 'meta.sqlite3');
  vectorPath = join(workDir, 'vec.db');
  claudeMemPath = join(workDir, 'claude-mem.db');
  copyFileSync(fixtureSrc, claudeMemPath);
  meta = new MetaStore(metaPath);
  vector = new VectorStore({ dbPath: vectorPath, dimension: 1024 });
});

afterAll(() => {
  vector.close();
  meta.close();
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

test('e2e — migration -> keyword search finds migrated content', async () => {
  await vector.ensureCollection('am_test');
  const r = await runMigration(
    {
      meta,
      embedder: fakeEmbedder,
      vector,
      collectionName: 'am_test',
      projectId: 'erp-platform',
      sourceDbPath: claudeMemPath,
    },
    {},
  );
  expect(r.errors).toBe(0);
  expect(r.observations_migrated).toBeGreaterThan(0);

  // Search for a unique narrative from fixture observation #2
  const hits = meta.searchKeyword('Locked', 5);
  expect(hits.length).toBeGreaterThan(0);
});

test('e2e — second run is fully no-op', async () => {
  const r = await runMigration(
    {
      meta,
      embedder: fakeEmbedder,
      vector,
      collectionName: 'am_test',
      projectId: 'erp-platform',
      sourceDbPath: claudeMemPath,
    },
    {},
  );
  expect(r.observations_migrated).toBe(0);
  expect(r.summaries_migrated).toBe(0);
});
