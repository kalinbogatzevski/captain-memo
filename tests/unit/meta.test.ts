import { test, expect, beforeEach, afterEach } from 'bun:test';
import { MetaStore, keywordMatchTokens, KEYWORD_MAX_TOKENS } from '../../src/worker/meta.ts';
import { unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Use the OS temp dir, not a hardcoded '/tmp' — '/tmp' doesn't exist on Windows,
// so `new Database('/tmp/…')` throws "unable to open database file" there.
const TEST_DB = join(tmpdir(), 'captain-memo-test-meta.sqlite3');
let store: MetaStore;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  store = new MetaStore(TEST_DB);
});

afterEach(() => {
  // Guard: if a beforeEach `new MetaStore` ever throws, `store` is undefined —
  // close defensively so the real error surfaces instead of a cascade.
  store?.close();
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

test('keywordMatchTokens — caps a long query, because FTS cost is linear in token count', () => {
  // Regression: searchKeyword OR'd EVERY token of the query into one FTS5 MATCH with no cap.
  // FTS5 unions one posting list per OR'd term, so cost grows linearly with token count —
  // measured on a 149,179-chunk corpus: 2 tokens 271ms, 30 → 1.06s, 60 → 2.15s, 120 → 4.85s,
  // 250 → 13.5s. The thread-RPC deadline is 10s, so an uncapped query 503s past ~185 tokens.
  // That is what a /remember dedup search on a large body did, and what every inbound peer
  // search carrying a long query did.
  const short = keywordMatchTokens('GLAB#367 fixed locked form fields');
  expect(short).toEqual(['GLAB', '367', 'fixed', 'locked', 'form', 'fields']);

  const long = keywordMatchTokens(Array.from({ length: 400 }, (_, i) => `token${i}`).join(' '));
  expect(long.length).toBeLessThanOrEqual(KEYWORD_MAX_TOKENS);
});

test('keywordMatchTokens — keeps the selective words and drops the stopwords', () => {
  // Length is a cheap proxy for selectivity: the short tokens are the ones whose posting
  // lists are most of the index, and they are exactly what makes the union expensive.
  const q = 'the a of to in on at is it be ' + 'thread_rpc_timeout federation orchestrator';
  const kept = keywordMatchTokens(q, 3);
  expect(kept).toEqual(['thread_rpc_timeout', 'federation', 'orchestrator']);
});

test('keywordMatchTokens — drops stopwords and 1-2 char tokens even under the cap', () => {
  // Measured 2026-09-16 on the live 191,104-chunk corpus, `chunks_fts MATCH` alone, read-only:
  // a 10-word natural-language prompt cost 1.6s; the same prompt minus the/and/does/where/when
  // cost 0.47s. 'the' is in 87% of chunks, 'and' in 91% — their posting lists ARE the union.
  const q = 'where does the worker auto update code live and when is it on';
  expect(keywordMatchTokens(q)).toEqual(['worker', 'auto', 'update', 'code', 'live']);
  // all-stopword query → nothing reaches FTS (the vector half still answers)
  expect(keywordMatchTokens('what is it and where')).toEqual([]);
});

test('keywordMatchTokens — dedupes, and preserves the original word order', () => {
  const kept = keywordMatchTokens('federation federation orchestrator federation');
  expect(kept).toEqual(['federation', 'orchestrator']);
});

test('MetaStore — searchKeyword still finds a distinctive term buried in a long query', () => {
  const docId = store.upsertDocument({
    source_path: '/abs/path/long.md',
    channel: 'memory',
    project_id: 'erp-platform',
    sha: 'abc',
    mtime_epoch: 1,
    metadata: {},
  });
  store.replaceChunksForDocument(docId, [
    { chunk_id: 'x', text: 'the zzqqxx marker lives here', sha: 's1', position: 0, metadata: {} },
    { chunk_id: 'y', text: 'unrelated filler about the deploy path', sha: 's2', position: 1, metadata: {} },
  ]);
  // A realistic "large body" query: lots of common words plus one distinctive term.
  const noise = 'the and of to in on at is it be for with from that this a an '.repeat(30);
  const hits = store.searchKeyword(`${noise} zzqqxx`, 5);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.chunk_id).toBe('x');
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

test('MetaStore — migration progress: mark + skip', () => {
  // Initially no rows are marked
  expect(store.isMigrationDone('observation', 1)).toBe(false);
  store.markMigrationDone('observation', 1, 'sha-abc');
  expect(store.isMigrationDone('observation', 1)).toBe(true);
  // Different table or different id
  expect(store.isMigrationDone('observation', 2)).toBe(false);
  expect(store.isMigrationDone('summary', 1)).toBe(false);
});

test('MetaStore — migration progress: counts', () => {
  store.markMigrationDone('observation', 1, 's1');
  store.markMigrationDone('observation', 2, 's2');
  store.markMigrationDone('summary', 1, 's3');
  const counts = store.migrationCounts();
  expect(counts.observation).toBe(2);
  expect(counts.summary).toBe(1);
});

test('MetaStore — listKvPrefix returns only prefixed keys, ordered by key', () => {
  store.setKv('inbox:capX:2', 'v2');
  store.setKv('inbox:capX:1', 'v1');
  store.setKv('inbox:capY:9', 'v9');
  store.setKv('other:z', 'vz');
  const rows = store.listKvPrefix('inbox:capX:');
  expect(rows).toEqual([
    { key: 'inbox:capX:1', value: 'v1' },
    { key: 'inbox:capX:2', value: 'v2' },
  ]);
});

test('MetaStore — listKvPrefix escapes LIKE wildcards (literal match only)', () => {
  store.setKv('a_b:1', 'underscore');
  store.setKv('axb:1', 'wildcard-trap');
  const rows = store.listKvPrefix('a_b:');
  expect(rows).toEqual([{ key: 'a_b:1', value: 'underscore' }]);
});

test('MetaStore — deleteKv removes a key and is a no-op on a missing key', () => {
  store.setKv('inbox:capX:1', 'v1');
  store.deleteKv('inbox:capX:1');
  expect(store.getKv('inbox:capX:1')).toBeNull();
  // Deleting a key that does not exist must not throw.
  expect(() => store.deleteKv('does:not:exist')).not.toThrow();
});
