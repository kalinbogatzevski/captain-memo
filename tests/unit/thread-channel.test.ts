import { test, expect } from 'bun:test';
import { ThreadChannel, type Transport } from '../../src/worker/thread-channel.ts';

// Two in-memory transports wired to each other, simulating main <-> engine postMessage.
function pair(): [Transport, Transport] {
  let cbA: (m: unknown) => void = () => {};
  let cbB: (m: unknown) => void = () => {};
  const a: Transport = { post: (m) => queueMicrotask(() => cbB(m)), onMessage: (cb) => { cbA = cb; } };
  const b: Transport = { post: (m) => queueMicrotask(() => cbA(m)), onMessage: (cb) => { cbB = cb; } };
  return [a, b];
}

test('bidirectional op routing: each side serves its own ops', async () => {
  const [ta, tb] = pair();
  const main = new ThreadChannel(ta, 1000);
  const engine = new ThreadChannel(tb, 1000);
  engine.serve('http', async (d) => ({ echo: d }));
  engine.serve('read', async (d) => ({ hits: [], q: d }));
  main.serve('ping', async (d) => ({ remote: true, q: d }));

  expect(await main.request('http', { a: 1 })).toEqual({ echo: { a: 1 } });
  expect(await main.request('read', { query: 'x' })).toEqual({ hits: [], q: { query: 'x' } });
  expect(await engine.request('ping', { query: 'y' })).toEqual({ remote: true, q: { query: 'y' } });
});

test('concurrent in-flight in both directions do not cross-resolve', async () => {
  const [ta, tb] = pair();
  const main = new ThreadChannel(ta, 1000);
  const engine = new ThreadChannel(tb, 1000);
  engine.serve('http', async (d) => ({ tag: 'http', n: (d as { n: number }).n }));
  main.serve('ping', async (d) => ({ tag: 'peer', n: (d as { n: number }).n }));
  const [r1, r2] = await Promise.all([main.request('http', { n: 1 }), engine.request('ping', { n: 2 })]);
  expect(r1).toEqual({ tag: 'http', n: 1 });
  expect(r2).toEqual({ tag: 'peer', n: 2 });
});

test('unknown op rejects with no_handler', async () => {
  const [ta, tb] = pair();
  const main = new ThreadChannel(ta, 1000);
  new ThreadChannel(tb, 1000); // engine serves nothing
  await expect(main.request('nope', {})).rejects.toThrow('no_handler:nope');
});

test('handler throw propagates the message to the requester', async () => {
  const [ta, tb] = pair();
  const main = new ThreadChannel(ta, 1000);
  const engine = new ThreadChannel(tb, 1000);
  engine.serve('http', async () => { throw new Error('boom'); });
  await expect(main.request('http', {})).rejects.toThrow('boom');
});
