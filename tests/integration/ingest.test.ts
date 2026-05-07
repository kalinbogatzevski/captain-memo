import { test, expect, beforeEach, afterEach } from 'bun:test';
import { IngestPipeline } from '../../src/worker/ingest.ts';
import { MetaStore } from '../../src/worker/meta.ts';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let workDir: string;
let dbPath: string;
let store: MetaStore;
let pipeline: IngestPipeline;

const fakeEmbedder = {
  embed: async (texts: string[]) =>
    texts.map(() => Array.from({ length: 8 }, () => Math.random())),
};

interface VecCall { kind: 'add' | 'delete'; collection: string; payload: unknown }
let vecCalls: VecCall[] = [];

const fakeVectorStore = {
  ensureCollection: async (_name: string) => {},
  add: async (collection: string, items: Array<{ id: string; embedding: number[] }>) => {
    vecCalls.push({ kind: 'add', collection, payload: items.map(i => i.id) });
  },
  delete: async (collection: string, ids: string[]) => {
    vecCalls.push({ kind: 'delete', collection, payload: ids });
  },
  query: async () => [],
  close: () => {},
};

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'aelita-ingest-'));
  dbPath = join(workDir, 'meta.sqlite3');
  store = new MetaStore(dbPath);
  vecCalls = [];
  pipeline = new IngestPipeline({
    meta: store,
    embedder: fakeEmbedder,
    vector: fakeVectorStore as any,
    collectionName: 'test_col',
    projectId: 'erp-platform',
  });
});

afterEach(() => {
  store.close();
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

test('IngestPipeline — indexes a memory file', async () => {
  const filePath = join(workDir, 'feedback_test.md');
  writeFileSync(filePath, '---\ntype: feedback\ndescription: test\n---\nDo not use vocative.');
  await pipeline.indexFile(filePath, 'memory');

  const doc = store.getDocument(filePath);
  expect(doc).not.toBeNull();
  expect(doc!.channel).toBe('memory');

  const chunks = store.getChunksForDocument(doc!.id);
  expect(chunks.length).toBe(1);
  expect(chunks[0]!.text).toContain('Do not use vocative');

  // Vector store received an `add` call with the chunk ID
  const adds = vecCalls.filter(c => c.kind === 'add');
  expect(adds.length).toBe(1);
  expect(adds[0]!.collection).toBe('test_col');
});

test('IngestPipeline — skips re-indexing when sha unchanged', async () => {
  const filePath = join(workDir, 'feedback_test.md');
  writeFileSync(filePath, 'unchanged content');
  await pipeline.indexFile(filePath, 'memory');
  const before = store.getDocument(filePath);
  const beforeIndexed = before!.last_indexed_epoch;
  const beforeAddCount = vecCalls.filter(c => c.kind === 'add').length;

  // Wait a sec to ensure mtime would change if rewritten
  await new Promise(r => setTimeout(r, 1100));

  await pipeline.indexFile(filePath, 'memory');
  const after = store.getDocument(filePath);
  expect(after!.last_indexed_epoch).toBe(beforeIndexed);
  // No additional vector store calls
  expect(vecCalls.filter(c => c.kind === 'add').length).toBe(beforeAddCount);
});

test('IngestPipeline — re-indexes when content changes', async () => {
  const filePath = join(workDir, 'feedback_test.md');
  writeFileSync(filePath, 'first version');
  await pipeline.indexFile(filePath, 'memory');
  const before = store.getDocument(filePath);

  writeFileSync(filePath, 'second version');
  await pipeline.indexFile(filePath, 'memory');
  const after = store.getDocument(filePath);

  expect(after!.sha).not.toBe(before!.sha);
  // Should have at least one delete (drop old chunk) + one add (new chunk)
  expect(vecCalls.filter(c => c.kind === 'delete').length).toBeGreaterThan(0);
});

test('IngestPipeline — deleteFile drops document and chunks + vectors', async () => {
  const filePath = join(workDir, 'feedback_test.md');
  writeFileSync(filePath, 'content');
  await pipeline.indexFile(filePath, 'memory');
  expect(store.getDocument(filePath)).not.toBeNull();

  await pipeline.deleteFile(filePath);
  expect(store.getDocument(filePath)).toBeNull();

  // Vector store should have received a delete for the chunk
  const deletes = vecCalls.filter(c => c.kind === 'delete');
  expect(deletes.length).toBeGreaterThan(0);
});
