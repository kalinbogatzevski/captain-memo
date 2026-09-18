// HOMEWORK over the worker's HTTP: file → list → claim → done → gone from the open list. The hook and the MCP
// tools speak only these four routes, so this is the contract they rely on.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';

let worker: WorkerHandle;
let base = '';
beforeAll(async () => {
  worker = await startWorker({
    port: 0, projectId: 'test-project', metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused', embedderModel: 'fake',
    vectorDbPath: ':memory:', embeddingDimension: 8, skipEmbed: true,
  });
  base = `http://localhost:${worker.port}`;
  await fetch(base + '/homework/list');   // the worker's first request after boot takes ~5.5 s (measured, not homework's doing) — absorb it here
});
afterAll(async () => { await worker.stop(); });

const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('file, list, claim, done — and the open list follows', async () => {
  const added = await (await post('/homework/add', { text: 'carry topics forward onto auto-claims', topics: ['Cockpit', 'work board'], by: 'erp-18', project: 'captain-memo' })).json() as { item: { id: string; topics: string[] }; open: number };
  expect(added.item.id).toBe('1');
  expect(added.item.topics).toEqual(['cockpit', 'work-board']);
  expect(added.open).toBe(1);
  await post('/homework/add', { text: 'second', by: 'hook' });

  const open = await (await fetch(base + '/homework/list?status=open')).json() as { items: Array<{ id: string; claimed_by?: string }>; open: number };
  expect(open.items.map((i) => i.id)).toEqual(['1', '2']);

  const claimed = await (await post('/homework/claim', { id: '#1', by: 'codex-3' })).json() as { item: { claimed_by?: string } };
  expect(claimed.item.claimed_by).toBe('codex-3');

  const done = await (await post('/homework/done', { id: '1', by: 'codex-3', note: 'shipped in 0.61.0' })).json() as { item: { done_at?: number; note?: string }; open: number };
  expect(typeof done.item.done_at).toBe('number');
  expect(done.item.note).toBe('shipped in 0.61.0');
  expect(done.open).toBe(1);

  const after = await (await fetch(base + '/homework/list')).json() as { items: Array<{ id: string }> };
  expect(after.items.map((i) => i.id)).toEqual(['2']);                       // default status is open
  const all = await (await fetch(base + '/homework/list?status=all')).json() as { items: Array<{ id: string }> };
  expect(all.items.map((i) => i.id)).toEqual(['1', '2']);

  expect((await post('/homework/done', { id: '99', by: 'x' })).status).toBe(404);
  expect((await post('/homework/add', { text: '   ' })).status).toBe(400);
}, 20_000);
