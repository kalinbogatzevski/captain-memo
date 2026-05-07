import { test, expect, beforeEach, afterEach } from 'bun:test';
import { VectorStore } from '../../src/worker/vector-store.ts';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let workDir: string;
let store: VectorStore;
const DIM = 4;  // small dim for tests

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'aelita-vec-test-'));
  store = new VectorStore({ dbPath: join(workDir, 'vectors.sqlite3'), dimension: DIM });
});

afterEach(() => {
  store.close();
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

test('VectorStore — ensureCollection is idempotent (no-op)', async () => {
  await store.ensureCollection('coll_a');
  await store.ensureCollection('coll_a');  // second call must not throw
});

test('VectorStore — adds vectors and queries by similarity', async () => {
  await store.add('coll_a', [
    { id: 'apple',  embedding: [1, 0, 0, 0] },
    { id: 'car',    embedding: [0, 1, 0, 0] },
    { id: 'cherry', embedding: [0.95, 0.05, 0, 0] },
  ]);
  const results = await store.query('coll_a', [1, 0, 0, 0], 3);
  expect(results.length).toBeGreaterThan(0);
  // Closest to [1,0,0,0] should be "apple" (exact match, distance ~0)
  expect(results[0]!.id).toBe('apple');
  // "cherry" should be next (very similar vector)
  expect(results[1]!.id).toBe('cherry');
});

test('VectorStore — query is scoped to the requested collection', async () => {
  await store.add('coll_a', [{ id: 'a1', embedding: [1, 0, 0, 0] }]);
  await store.add('coll_b', [{ id: 'b1', embedding: [1, 0, 0, 0] }]);
  const a = await store.query('coll_a', [1, 0, 0, 0], 5);
  const b = await store.query('coll_b', [1, 0, 0, 0], 5);
  expect(a.map(r => r.id)).toEqual(['a1']);
  expect(b.map(r => r.id)).toEqual(['b1']);
});

test('VectorStore — delete removes specified ids only', async () => {
  await store.add('coll_a', [
    { id: 'd1', embedding: [1, 0, 0, 0] },
    { id: 'd2', embedding: [0, 1, 0, 0] },
  ]);
  await store.delete('coll_a', ['d1']);
  const results = await store.query('coll_a', [1, 0, 0, 0], 5);
  expect(results.find(r => r.id === 'd1')).toBeUndefined();
  expect(results.find(r => r.id === 'd2')).toBeDefined();
});

test('VectorStore — rejects embeddings of wrong dimension', async () => {
  await expect(
    store.add('coll_a', [{ id: 'wrong', embedding: [1, 2] }]),  // 2 dims != DIM (4)
  ).rejects.toThrow(/dimension/);
});

test('VectorStore — rejects query embedding of wrong dimension', async () => {
  await expect(
    store.query('coll_a', [1, 2], 5),
  ).rejects.toThrow(/dimension/);
});
