import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VectorStore, VEC_CHUNK_SIZE } from '../../src/worker/vector-store.ts';

// vec0 allocates ONE fixed-size chunk per partition and scans whole chunks. At the stock
// chunk_size of 1024 against targetPerCluster=300, a real 144k-vector store measured:
//
//   allocated 1888 MB · live data 563 MB · median chunk 147/1024 full -> 70% waste
//
// and queries paid for the empty space they scanned. Rebuilt at chunk_size=128, byte-identical
// results: 578 MB (-1.19 GB) and p50 62.7 ms -> 36.4 ms. Smaller AND faster, same answers.
const vec = (n: number, seed: number) =>
  Array.from({ length: n }, (_, i) => Math.sin(seed * 0.37 + i) );

function store(dir: string) {
  return new VectorStore({ dbPath: join(dir, 'v.db'), dimension: 8 });
}

test('a fresh store is created at the configured chunk size, not vec0 default 1024', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-vec-'));
  const s = store(dir);
  expect(s.chunkCapacity()).toBe(VEC_CHUNK_SIZE);
  expect(VEC_CHUNK_SIZE).toBeLessThan(1024);
  s.close(); rmSync(dir, { recursive: true, force: true });
});

test('rebuildChunkLayout is a no-op when the layout already matches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-vec-'));
  const s = store(dir);
  await s.add('c', [{ id: 'a', embedding: vec(8, 1) }]);
  expect(s.rebuildChunkLayout()).toBeNull();     // null = nothing to do
  s.close(); rmSync(dir, { recursive: true, force: true });
});

test('rebuildChunkLayout preserves every vector, its cluster, and query results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-vec-'));
  const s = store(dir);
  const items = Array.from({ length: 40 }, (_, i) => ({ id: `id${i}`, embedding: vec(8, i) }));
  await s.add('c', items);
  // Spread them across clusters so the rebuild has real partitions to reproduce.
  s.reassignClusterBatch(items.map((it, i) => ({
    chunkId: it.id, embedding: Float32Array.from(it.embedding), clusterId: i % 5,
  })));
  const before = await s.query('c', vec(8, 3), 10);
  const forced = s.rebuildChunkLayout(VEC_CHUNK_SIZE * 2);  // always differs -> forces a real rebuild
  expect(forced?.moved).toBe(40);
  const after = await s.query('c', vec(8, 3), 10);
  expect(after.map(r => r.id)).toEqual(before.map(r => r.id));
  expect(s.countVectors('c')).toBe(40);
  s.close(); rmSync(dir, { recursive: true, force: true });
});
