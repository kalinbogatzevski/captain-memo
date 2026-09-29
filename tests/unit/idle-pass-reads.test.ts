import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readPaged, PAGE_ROWS } from '../../src/shared/paged-read.ts';
import { MetaStore } from '../../src/worker/meta.ts';
import { VectorStore } from '../../src/worker/vector-store.ts';

// The idle passes' reads (2026-09-29): paged so they never hold the writer, and rewritten onto
// indexes. Each must return exactly what the slow version did.

test('readPaged returns every row across page boundaries, yielding between pages', async () => {
  const all = Array.from({ length: PAGE_ROWS * 2 + 7 }, (_, i) => ({ id: i + 1 }));
  let yields = 0;
  const got = await readPaged(
    (after, limit) => all.filter(r => r.id > after).slice(0, limit),
    r => r.id,
    async () => { yields++; },
  );
  expect(got.map(r => r.id)).toEqual(all.map(r => r.id));
  expect(yields).toBe(2);
});

test('MetaStore channelCount and observationIdsByChunk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-meta-'));
  const m = new MetaStore(join(dir, 'm.db'));
  expect(m.channelCount()).toBe(0);
  const doc = (source_path: string, channel: string) => m.upsertDocument({
    source_path, channel: channel as never, project_id: 'p', sha: 's', mtime_epoch: 1, metadata: {},
  });
  const chunk = (id: string) => ({ chunk_id: id, text: 't', sha: 's', position: 0, metadata: {} });
  m.replaceChunksForDocument(doc('observation:default:42', 'observation'), [chunk('observation:42:aaaa'), { ...chunk('observation:42:bbbb'), position: 1 }]);
  // A claude-mem import: its chunk id says observation:1, but it is not our observation 1.
  m.replaceChunksForDocument(doc('claude-mem://observation/1', 'observation'), [chunk('observation:1:cccc')]);
  m.replaceChunksForDocument(doc('/notes/a.md', 'memory'), [chunk('memory:a:dddd')]);
  expect(m.channelCount()).toBe(2);
  expect(m.totalChunks()).toBe(4);
  expect([...(await m.observationIdsByChunk()).entries()].sort()).toEqual([
    ['observation:42:aaaa', 42], ['observation:42:bbbb', 42],
  ]);
  m.close(); rmSync(dir, { recursive: true, force: true });
});

test('clusterMembership off the shadow tables matches the vec0 scan, across pages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-vec-'));
  const s = new VectorStore({ dbPath: join(dir, 'v.db'), dimension: 8 });
  const vec = (seed: number) => Array.from({ length: 8 }, (_, i) => Math.sin(seed * 0.37 + i));
  const items = Array.from({ length: PAGE_ROWS + 300 }, (_, i) => ({ id: `id${i}`, embedding: vec(i) }));
  await s.add('c', items);
  await s.add('other', [{ id: 'x1', embedding: vec(9999) }]);   // another collection stays out
  s.reassignClusterBatch(items.map((it, i) => ({ chunkId: it.id, embedding: Float32Array.from(it.embedding), clusterId: i % 7 })));
  const got = await s.clusterMembership('c');
  const db = (s as unknown as { db: import('bun:sqlite').Database }).db;
  const want = new Map<number, string[]>();
  for (const r of db.query('SELECT cluster_id, chunk_id FROM vec_chunks_p').all() as Array<{ cluster_id: number; chunk_id: string }>) {
    if (r.chunk_id === 'x1') continue;
    want.set(r.cluster_id, [...(want.get(r.cluster_id) ?? []), r.chunk_id]);
  }
  // The shadow layout this read depends on (else it silently falls back to the slow scan).
  expect(() => db.query('SELECT r.id, c.partition00 FROM vec_chunks_p_rowids r JOIN vec_chunks_p_chunks c ON c.chunk_id = r.chunk_id LIMIT 1').all()).not.toThrow();
  const norm = (mp: Map<number, string[]>) => [...mp.entries()].map(([k, v]) => [k, [...v].sort()]).sort((a, b) => Number(a[0]) - Number(b[0]));
  expect(norm(got)).toEqual(norm(want));
  expect([...got.values()].flat()).toHaveLength(items.length);
  s.close(); rmSync(dir, { recursive: true, force: true });
});

test('unclustered / clustered reads off the shadow tables match vec0, deleted vectors excluded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-vec-'));
  const s = new VectorStore({ dbPath: join(dir, 'v.db'), dimension: 8 });
  const vec = (seed: number) => Array.from({ length: 8 }, (_, i) => Math.cos(seed * 0.51 + i));
  const items = Array.from({ length: 60 }, (_, i) => ({ id: `u${i}`, embedding: vec(i) }));
  await s.add('c', items);                                   // no centroids yet: all unclustered
  s.reassignClusterBatch(items.slice(0, 40).map((it, i) => ({ chunkId: it.id, embedding: Float32Array.from(it.embedding), clusterId: i % 3 })));
  await s.delete('c', ['u45', 'u46', 'u5']);                 // one unclustered pair and one clustered row gone
  const db = (s as unknown as { db: import('bun:sqlite').Database }).db;
  const vec0 = (where: string) => (db.query(`SELECT chunk_id FROM vec_chunks_p WHERE ${where}`).all() as Array<{ chunk_id: string }>).map(r => r.chunk_id).sort();
  expect(s.getUnclusteredChunks('c', 100).map(r => r.chunkId).sort()).toEqual(vec0('cluster_id = -1'));
  expect(s.getUnclusteredChunks('c', 100)).toHaveLength(18);
  const sample = s.sampleClusteredVectors('c', 100);
  expect(sample.map(r => r.chunkId).sort()).toEqual(vec0('cluster_id != -1'));
  expect(sample.find(r => r.chunkId === 'u7')?.clusterId).toBe(7 % 3);
  expect(sample[0]!.embedding).toHaveLength(8);
  s.close(); rmSync(dir, { recursive: true, force: true });
});
