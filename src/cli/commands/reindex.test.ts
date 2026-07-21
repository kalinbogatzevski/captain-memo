import { test, expect } from 'bun:test';
import { redimReindex, reindexCommand, type RedimDeps } from './reindex.ts';
import type { ServiceManager } from '../../services/service-manager/types.ts';

// A fake ServiceManager that records the order of stop/start calls into a shared log.
function fakeSm(order: string[]) {
  return {
    stop: async (name: string, opts: unknown) => { order.push(`stop:${name}:${JSON.stringify(opts)}`); },
    start: async (name: string) => { order.push(`start:${name}`); },
  } as unknown as ServiceManager;
}

function baseDeps(order: string[], over: Partial<RedimDeps> = {}): RedimDeps {
  return {
    sm: fakeSm(order),
    port: 39888,
    probe: async () => true,
    sleep: async () => {},
    now: () => 0,
    setEnv: (k, v) => order.push(`setEnv:${k}=${v}`),
    rmVectorDb: () => order.push('rmVectorDb'),
    reindexAll: async () => { order.push('reindexAll'); return { indexed: 5, skipped: 0, errors: 0 }; },
    log: () => {},
    ...over,
  };
}

test('redim: stop → setEnv → drop index → start → reindex, in that order; returns 0', async () => {
  const order: string[] = [];
  const code = await redimReindex(1024, baseDeps(order));
  expect(code).toBe(0);
  expect(order).toEqual([
    'stop:captain-memo-worker:{"graceful":true,"port":39888,"force":true}',
    'setEnv:CAPTAIN_MEMO_EMBEDDING_DIM=1024',
    'rmVectorDb',
    'start:captain-memo-worker',
    'reindexAll',
  ]);
});

test('redim: rejects a non-positive / non-integer dimension without touching the worker', async () => {
  const order: string[] = [];
  expect(await redimReindex(0, baseDeps(order))).toBe(2);
  expect(await redimReindex(1024.5, baseDeps(order))).toBe(2);
  expect(order).toEqual([]);
});

test('redim: worker never becomes healthy → returns 1 and does NOT reindex', async () => {
  const order: string[] = [];
  let t = 0;
  const code = await redimReindex(1024, baseDeps(order, {
    probe: async () => false,
    now: () => { t += 5000; return t; },
  }));
  expect(code).toBe(1);
  expect(order).not.toContain('reindexAll');
});

test('reindexCommand --redim validates the argument', async () => {
  expect(await reindexCommand(['--redim'])).toBe(2);       // missing value
  expect(await reindexCommand(['--redim', 'abc'])).toBe(2); // not a number
  expect(await reindexCommand(['--redim', '-1'])).toBe(2);  // not positive
});
