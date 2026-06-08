import { test, expect } from 'bun:test';
import { ThreadChannel, type Transport } from '../../../src/worker/thread-channel.ts';

// In-memory transport pair wiring two channels together (no real Worker needed).
// Async delivery via queueMicrotask mirrors tests/unit/thread-channel.test.ts so the
// whole suite exercises ThreadChannel under one consistent message-delivery semantic.
function pair(): [Transport, Transport] {
  let cbA: (m: unknown) => void = () => {};
  let cbB: (m: unknown) => void = () => {};
  const a: Transport = { post: (m) => queueMicrotask(() => cbB(m)), onMessage: (cb) => { cbA = cb; } };
  const b: Transport = { post: (m) => queueMicrotask(() => cbA(m)), onMessage: (cb) => { cbB = cb; } };
  return [a, b];
}

test('request resolves with the responder result, correlated by id', async () => {
  const [ta, tb] = pair();
  const a = new ThreadChannel(ta);
  const b = new ThreadChannel(tb);
  b.serve('http', async (data) => ({ ok: true, got: data }));
  const res = await a.request('http', { q: 'hi' });
  expect(res).toEqual({ ok: true, got: { q: 'hi' } });
});

test('two concurrent requests resolve to their own results', async () => {
  const [ta, tb] = pair();
  const a = new ThreadChannel(ta);
  const b = new ThreadChannel(tb);
  b.serve('http', async (data: any) => ({ n: data.n * 10 }));
  const [r1, r2] = await Promise.all([a.request('http', { n: 1 }), a.request('http', { n: 2 })]);
  expect(r1).toEqual({ n: 10 });
  expect(r2).toEqual({ n: 20 });
});

test('responder error rejects the requester', async () => {
  const [ta, tb] = pair();
  const a = new ThreadChannel(ta);
  const b = new ThreadChannel(tb);
  b.serve('http', async () => { throw new Error('boom'); });
  await expect(a.request('http', {})).rejects.toThrow('boom');
});

test('request times out when no response arrives', async () => {
  const ch = new ThreadChannel({ post: () => {}, onMessage: () => {} }, 30);
  await expect(ch.request('http', {})).rejects.toThrow('thread_rpc_timeout');
});

test('rejectAll fails in-flight (used on engine crash)', async () => {
  const ch = new ThreadChannel({ post: () => {}, onMessage: () => {} }, 5000);
  const p = ch.request('http', {});
  ch.rejectAll('engine_gone');
  await expect(p).rejects.toThrow('engine_gone');
});
