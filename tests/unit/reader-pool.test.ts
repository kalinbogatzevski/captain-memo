import { test, expect } from 'bun:test';
import { ReaderPool } from '../../src/worker/reader-pool.ts';

test('pick returns null when empty, a member when populated', () => {
  const pool = new ReaderPool<string>();
  expect(pool.pick()).toBeNull();
  pool.add('a'); pool.add('b');
  expect(['a', 'b']).toContain(pool.pick()!);
});

test('pick spreads load: least in-flight wins', () => {
  const pool = new ReaderPool<string>(2);
  pool.add('a'); pool.add('b');
  const first = pool.pick()!; pool.acquire(first);   // first:1
  const second = pool.pick()!;                        // should be the other one (0 in-flight)
  expect(second).not.toBe(first);
});

test('all-busy returns null; release frees capacity', () => {
  const pool = new ReaderPool<string>(/* maxInFlightPerReader */ 1);
  pool.add('a');
  const r = pool.pick()!; pool.acquire(r);
  expect(pool.pick()).toBeNull();      // a is at capacity
  pool.release(r);
  expect(pool.pick()).toBe('a');
});

test('remove drops a crashed reader', () => {
  const pool = new ReaderPool<string>();
  pool.add('a'); pool.add('b'); pool.remove('a');
  expect(pool.size()).toBe(1);
  expect(pool.pick()).toBe('b');
});

test('add is idempotent (re-adding does not duplicate)', () => {
  const pool = new ReaderPool<string>();
  pool.add('a'); pool.add('a');
  expect(pool.size()).toBe(1);
});
