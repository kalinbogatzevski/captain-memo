import { test, expect } from 'bun:test';
import { ThreadChannel } from '../../../src/worker/thread-channel.ts';

// In-memory transport pair wiring two channels together (no real Worker needed).
function pair() {
  let aRecv!: (m: unknown) => void, bRecv!: (m: unknown) => void;
  const a = new ThreadChannel({ post: (m) => bRecv(m), onMessage: (cb) => { aRecv = cb; } });
  const b = new ThreadChannel({ post: (m) => aRecv(m), onMessage: (cb) => { bRecv = cb; } });
  return { a, b };
}

test('request resolves with the responder result, correlated by id', async () => {
  const { a, b } = pair();
  b.serve(async (data) => ({ ok: true, got: data }));
  const res = await a.request({ q: 'hi' });
  expect(res).toEqual({ ok: true, got: { q: 'hi' } });
});

test('two concurrent requests resolve to their own results', async () => {
  const { a, b } = pair();
  b.serve(async (data: any) => ({ n: data.n * 10 }));
  const [r1, r2] = await Promise.all([a.request({ n: 1 }), a.request({ n: 2 })]);
  expect(r1).toEqual({ n: 10 });
  expect(r2).toEqual({ n: 20 });
});

test('responder error rejects the requester', async () => {
  const { a, b } = pair();
  b.serve(async () => { throw new Error('boom'); });
  await expect(a.request({})).rejects.toThrow('boom');
});

test('request times out when no response arrives', async () => {
  const ch = new ThreadChannel({ post: () => {}, onMessage: () => {} }, 30);
  await expect(ch.request({})).rejects.toThrow('thread_rpc_timeout');
});

test('rejectAll fails in-flight (used on engine crash)', async () => {
  const ch = new ThreadChannel({ post: () => {}, onMessage: () => {} }, 5000);
  const p = ch.request({});
  ch.rejectAll('engine_gone');
  await expect(p).rejects.toThrow('engine_gone');
});
