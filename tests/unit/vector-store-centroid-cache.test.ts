// tests/unit/vector-store-centroid-cache.test.ts
//
// getCentroids() used to re-read and re-parse every centroid blob on EVERY query — 477 × 1024 floats,
// measured 92-202 ms per call on the live store (2026-09-16), paid by each reader on each search while
// the centroids only move on a sweep tick. The cache must (1) hand back the same set without re-parsing,
// (2) never hide a structural change (a rebuild allocates NEW ids — probing dead ids returns nothing),
// (3) be dropped by the instance that rewrites the set, so the writer's sweep never updates stale
// centroids, and (4) refresh on its TTL so per-tick drift reaches readers.
import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { VectorStore } from '../../src/worker/vector-store.ts';

const DIM = 4;
const cents = (ids: number[], x: number) => ids.map((clusterId) => ({ clusterId, hitCount: 1, vector: [x, 0, 0, 0] }));

function open(dir: string, readonly: boolean, ttl?: number): VectorStore {
  return new VectorStore({ dbPath: join(dir, 'vec.db'), dimension: DIM, readonly, ...(ttl !== undefined ? { centroidCacheTtlMs: ttl } : {}) });
}

test('a reader reuses its parsed centroids until the TTL, and sees a structural rewrite at once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-centroid-cache-'));
  try {
    const writer = open(dir, false);
    await writer.ensureCollection('c');
    writer.setCentroids('c', cents([1, 2, 3], 0.1));

    const reader = open(dir, true, 200);
    const first = reader.getCentroids('c');
    expect(first.map((c) => c.clusterId)).toEqual([1, 2, 3]);
    expect(reader.getCentroids('c')).toBe(first);                 // same object: no re-read, no re-parse

    writer.setCentroids('c', cents([1, 2, 3], 0.9));              // same ids, moved vectors = per-tick drift
    expect(reader.getCentroids('c')).toBe(first);                 // within TTL: drift is allowed to lag

    writer.setCentroids('c', cents([4, 5, 6, 7], 0.5));           // rebuild: NEW ids — must NOT lag
    expect(reader.getCentroids('c').map((c) => c.clusterId)).toEqual([4, 5, 6, 7]);

    writer.setCentroids('c', cents([4, 5, 6, 7], 0.6));
    await new Promise((r) => setTimeout(r, 250));                 // past the TTL: drift arrives
    expect(reader.getCentroids('c')[0]!.vector[0]).toBeCloseTo(0.6);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the instance that rewrites the set never reads its own stale copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-centroid-cache-'));
  try {
    const writer = open(dir, false, 60_000);
    await writer.ensureCollection('c');
    writer.setCentroids('c', cents([1, 2], 0.1));
    expect(writer.getCentroids('c')[0]!.vector[0]).toBeCloseTo(0.1);
    writer.setCentroids('c', cents([1, 2], 0.7));                 // same ids, same count: only the vectors moved
    expect(writer.getCentroids('c')[0]!.vector[0]).toBeCloseTo(0.7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
