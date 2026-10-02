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

test('#129: /whats-new reads this checkout\'s CHANGELOG, bounded; no range, no items', async () => {
  const r = await (await fetch(base + '/whats-new?from=0.0.0&to=999.0.0')).json() as { items: Array<{ version: string; text: string }> };
  expect(r.items).toHaveLength(20);
  expect(typeof r.items[0]!.text).toBe('string');
  expect(((await (await fetch(base + '/whats-new')).json()) as { items: unknown[] }).items).toEqual([]);
});

test('due: the route stores it as UTC and lists it back; a past due is accepted; no due leaves no key', async () => {
  const add = async (body: Record<string, unknown>) => (await (await post('/homework/add', body)).json()) as { item: { id: string; due?: string }; open: number };
  const zoned = await add({ text: 'reminder with a zone', due: '2020-01-01T00:05+02:00' });
  expect(zoned.item.due).toBe('2019-12-31T22:05:00.000Z');                       // long past: accepted, it will show as overdue
  const prevTz = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';                                                  // the worker runs in this process: pin the host zone
  try { expect((await add({ text: 'a date only', due: '2020-01-01' })).item.due).toBe('2019-12-31T15:00:00.000Z'); }   // this host's midnight, not UTC's
  finally { if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz; }
  const plain = await add({ text: 'no due time' });
  expect('due' in plain.item).toBe(false);
  const open = await (await fetch(base + '/homework/list')).json() as { items: Array<{ id: string; due?: string }> };
  expect(open.items.find((i) => i.id === zoned.item.id)?.due).toBe('2019-12-31T22:05:00.000Z');
  expect('due' in open.items.find((i) => i.id === plain.item.id)!).toBe(false);
  const claimed = await (await post('/homework/claim', { id: zoned.item.id, by: 'codex-3' })).json() as { item: { due?: string } };
  expect(claimed.item.due).toBe('2019-12-31T22:05:00.000Z');                      // claiming keeps it
}, 20_000);

test('due: the route refuses a bad value with a clear message and files nothing', async () => {
  const before = (await (await fetch(base + '/homework/list?status=all')).json() as { items: unknown[] }).items.length;
  for (const due of ['tomorrow', '2026-02-30', '2026-09-31T10:00', '', null, 5, ['2026-10-01'], {}]) {
    const r = await post('/homework/add', { text: 'never filed', due });
    expect(r.status, JSON.stringify(due)).toBe(400);
    const j = await r.json() as { error: string; details: string };
    expect(j.error).toBe('invalid_request');
    expect(j.details).toContain('due must be an ISO 8601 date or date-time');
  }
  const after = (await (await fetch(base + '/homework/list?status=all')).json() as { items: unknown[] }).items.length;
  expect(after).toBe(before);
}, 20_000);

test('unclaim: the route hands back your own claim and refuses another session, an unclaimed item and an unknown one', async () => {
  const id = ((await (await post('/homework/add', { text: 'look first', by: 'a' })).json()) as { item: { id: string } }).item.id;
  expect((await post('/homework/unclaim', { id, by: 'erp-17' })).status).toBe(409);               // nobody holds it
  await post('/homework/claim', { id, by: 'erp-17' });
  const other = await post('/homework/unclaim', { id, by: 'erp-18' });
  expect(other.status).toBe(409); expect(((await other.json()) as { error: string }).error).toBe('not_yours');
  const ok = await (await post('/homework/unclaim', { id: '#' + id, by: 'erp-17' })).json() as { item: { claimed_by?: string } };
  expect(ok.item.claimed_by).toBeUndefined();
  const list = await (await fetch(base + '/homework/list?status=open')).json() as { items: Array<{ id: string; claimed_by?: string }> };
  expect(list.items.find((i) => i.id === id)?.claimed_by).toBeUndefined();
  expect((await post('/homework/unclaim', { id: '9999', by: 'x' })).status).toBe(404);
  expect((await post('/homework/unclaim', { by: 'x' })).status).toBe(400);
}, 20_000);
