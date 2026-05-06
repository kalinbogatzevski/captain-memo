import { test, expect, beforeEach, afterEach } from 'bun:test';
import { MetaStore } from '../../src/worker/meta.ts';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB = '/tmp/aelita-mcp-test-meta.sqlite3';
let store: MetaStore;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  store = new MetaStore(TEST_DB);
});

afterEach(() => {
  store.close();
});

test('MetaStore — initializes schema on first open', () => {
  expect(store.getDocument('/nonexistent')).toBeNull();
});

test('MetaStore — upsertDocument creates new document', () => {
  const id = store.upsertDocument({
    source_path: '/abs/path/foo.md',
    channel: 'memory',
    project_id: 'erp-platform',
    sha: 'abc123',
    mtime_epoch: 1000,
    metadata: { description: 'test' },
  });
  expect(typeof id).toBe('number');
  const doc = store.getDocument('/abs/path/foo.md');
  expect(doc).not.toBeNull();
  expect(doc!.id).toBe(id);
  expect(doc!.sha).toBe('abc123');
  expect(doc!.metadata.description).toBe('test');
});

test('MetaStore — upsertDocument updates existing document', () => {
  const id1 = store.upsertDocument({
    source_path: '/abs/path/foo.md',
    channel: 'memory',
    project_id: 'erp-platform',
    sha: 'abc123',
    mtime_epoch: 1000,
    metadata: {},
  });
  const id2 = store.upsertDocument({
    source_path: '/abs/path/foo.md',
    channel: 'memory',
    project_id: 'erp-platform',
    sha: 'def456',
    mtime_epoch: 2000,
    metadata: {},
  });
  expect(id2).toBe(id1);
  const doc = store.getDocument('/abs/path/foo.md');
  expect(doc!.sha).toBe('def456');
  expect(doc!.mtime_epoch).toBe(2000);
});

test('MetaStore — deleteDocument removes by source_path', () => {
  store.upsertDocument({
    source_path: '/abs/path/foo.md',
    channel: 'memory',
    project_id: 'erp-platform',
    sha: 'abc',
    mtime_epoch: 1,
    metadata: {},
  });
  store.deleteDocument('/abs/path/foo.md');
  expect(store.getDocument('/abs/path/foo.md')).toBeNull();
});

test('MetaStore — replaceChunksForDocument inserts chunks', () => {
  const docId = store.upsertDocument({
    source_path: '/abs/path/foo.md',
    channel: 'memory',
    project_id: 'erp-platform',
    sha: 'abc',
    mtime_epoch: 1,
    metadata: {},
  });
  store.replaceChunksForDocument(docId, [
    { chunk_id: 'memory:foo:aaaa1111', text: 'first chunk', sha: 'sha1', position: 0, metadata: { type: 'a' } },
    { chunk_id: 'memory:foo:bbbb2222', text: 'second chunk', sha: 'sha2', position: 1, metadata: { type: 'b' } },
  ]);
  const chunks = store.getChunksForDocument(docId);
  expect(chunks).toHaveLength(2);
  expect(chunks[0]!.text).toBe('first chunk');
  expect(chunks[1]!.metadata.type).toBe('b');
});

test('MetaStore — replaceChunksForDocument replaces all existing on rerun', () => {
  const docId = store.upsertDocument({
    source_path: '/abs/path/foo.md',
    channel: 'memory',
    project_id: 'erp-platform',
    sha: 'abc',
    mtime_epoch: 1,
    metadata: {},
  });
  store.replaceChunksForDocument(docId, [
    { chunk_id: 'memory:foo:aaaa1111', text: 'old', sha: 'old', position: 0, metadata: {} },
  ]);
  store.replaceChunksForDocument(docId, [
    { chunk_id: 'memory:foo:bbbb2222', text: 'new', sha: 'new', position: 0, metadata: {} },
  ]);
  const chunks = store.getChunksForDocument(docId);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.text).toBe('new');
});

test('MetaStore — searchKeyword via FTS5 returns ranked chunks', () => {
  const docId = store.upsertDocument({
    source_path: '/abs/path/foo.md',
    channel: 'memory',
    project_id: 'erp-platform',
    sha: 'abc',
    mtime_epoch: 1,
    metadata: {},
  });
  store.replaceChunksForDocument(docId, [
    { chunk_id: 'a', text: 'GLAB#367 fixed locked form fields', sha: 's1', position: 0, metadata: {} },
    { chunk_id: 'b', text: 'rebuilt the cashbox UI', sha: 's2', position: 1, metadata: {} },
    { chunk_id: 'c', text: 'GLAB#366 was about smart defaults', sha: 's3', position: 2, metadata: {} },
  ]);
  const hits = store.searchKeyword('GLAB#367', 5);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.chunk_id).toBe('a');
});

test('MetaStore — getChunkById returns chunk + parent document', () => {
  const docId = store.upsertDocument({
    source_path: '/abs/path/foo.md',
    channel: 'memory',
    project_id: 'erp-platform',
    sha: 'abc',
    mtime_epoch: 1,
    metadata: { description: 'doc-meta' },
  });
  store.replaceChunksForDocument(docId, [
    { chunk_id: 'foo:aaaa1111', text: 'hello', sha: 's', position: 0, metadata: { type: 'a' } },
  ]);
  const result = store.getChunkById('foo:aaaa1111');
  expect(result).not.toBeNull();
  expect(result!.chunk.text).toBe('hello');
  expect(result!.document.metadata.description).toBe('doc-meta');
});
