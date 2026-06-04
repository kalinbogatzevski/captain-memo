import { test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MetaStore } from '../../src/worker/meta.ts';
import { VectorStore } from '../../src/worker/vector-store.ts';
import { ObservationsStore } from '../../src/worker/observations-store.ts';

function tmp() { return mkdtempSync(join(tmpdir(), 'cm-ro-')); }

test('MetaStore readonly opens an existing db and reads without DDL; writes fail', () => {
  const dir = tmp(); const path = join(dir, 'meta.db');
  const rw = new MetaStore(path);                 // writer creates schema
  rw.upsertDocument({ source_path: 'a', channel: 'memory', project_id: 'p', sha: 's', mtime_epoch: 1, metadata: {} });
  const ro = new MetaStore(path, { readonly: true });
  expect(() => ro.stats()).not.toThrow();         // read works
  // a write on the readonly handle must fail (readonly db is enforced by sqlite)
  expect(() => ro.upsertDocument({ source_path: 'b', channel: 'memory', project_id: 'p', sha: 's', mtime_epoch: 1, metadata: {} })).toThrow();
});

test('VectorStore readonly can query an existing db', async () => {
  const dir = tmp(); const path = join(dir, 'vec.db');
  const rw = new VectorStore({ dbPath: path, dimension: 4 });
  await rw.add('default', [{ id: 'x', embedding: [1, 0, 0, 0] }]);
  const ro = new VectorStore({ dbPath: path, dimension: 4, readonly: true });
  const hits = await ro.query('default', [1, 0, 0, 0], 5);
  expect(hits.length).toBe(1);
  expect(hits[0]!.id).toBe('x');
});

test('ObservationsStore readonly reads but rejects writes', () => {
  const dir = tmp(); const path = join(dir, 'obs.db');
  new ObservationsStore(path);   // writer creates schema + migrations
  const ro = new ObservationsStore(path, { readonly: true });
  expect(() => ro.countAll()).not.toThrow();
  // a retrieval bump is a write — sqlite must reject it on a readonly handle (the corpus-safety net
  // if a bump ever reached a reader's store instead of being forwarded to the writer).
  expect(() => ro.bumpRetrieval([1], 'search')).toThrow();
});
