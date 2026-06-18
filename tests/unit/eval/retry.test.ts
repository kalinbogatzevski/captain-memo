import { test, expect } from 'bun:test';
import { postWithRetry } from '../../../src/eval/retry.ts';

test('retries once on a retryable error then succeeds', async () => {
  let n = 0;
  const r = await postWithRetry(async () => {
    n++;
    if (n === 1) throw new Error('500: {"error":"thread_rpc_timeout"}');
    return 'ok';
  });
  expect(r).toBe('ok');
  expect(n).toBe(2);
});

test('does not retry a non-retryable error', async () => {
  let n = 0;
  await expect(postWithRetry(async () => { n++; throw new Error('invalid_request'); })).rejects.toThrow('invalid_request');
  expect(n).toBe(1);
});

test('rethrows after exhausting retries', async () => {
  let n = 0;
  await expect(postWithRetry(async () => { n++; throw new Error('thread_rpc_timeout'); }, { tries: 2 })).rejects.toThrow('thread_rpc_timeout');
  expect(n).toBe(2);
});
