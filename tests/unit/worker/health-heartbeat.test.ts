import { test, expect } from 'bun:test';
import { healthFromHeartbeat } from '../../../src/worker/health-heartbeat.ts';

test('fresh beat -> healthy', () => {
  expect(healthFromHeartbeat({ lastBeatMs: 1000, busyOp: null }, 1200, 5000)).toEqual({ healthy: true });
});

test('stale beat -> degraded with age + busy op', () => {
  const v = healthFromHeartbeat({ lastBeatMs: 1000, busyOp: '/search/all' }, 9000, 5000);
  expect(v.healthy).toBe(false);
  expect(v.degraded).toContain('8000ms');
  expect(v.degraded).toContain('/search/all');
});

test('stale + idle -> degraded mentions idle', () => {
  const v = healthFromHeartbeat({ lastBeatMs: 0, busyOp: null }, 6000, 5000);
  expect(v.healthy).toBe(false);
  expect(v.degraded).toContain('idle');
});
