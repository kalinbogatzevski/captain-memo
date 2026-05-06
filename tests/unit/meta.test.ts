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
