// tests/unit/stats-uptime.test.ts — the compact uptime formatter shown on the
// stats page ("Worker ● online · up …"). Two-unit so a just-restarted worker
// reads "2m", not "0 h" (a silently-restarting worker should be visible).
import { test, expect } from 'bun:test';
import { fmtUptime } from '../../src/cli/stats-render.ts';

test('sub-minute → seconds', () => { expect(fmtUptime(45)).toBe('45s'); });
test('minutes only', () => { expect(fmtUptime(125)).toBe('2m'); });
test('hours + minutes (the early-restart case)', () => {
  expect(fmtUptime(2 * 3600 + 13 * 60 + 5)).toBe('2h 13m');
});
test('days + hours', () => {
  expect(fmtUptime(3 * 86400 + 4 * 3600 + 30 * 60)).toBe('3d 4h');
});
test('clamps negative / zero', () => {
  expect(fmtUptime(-10)).toBe('0s');
  expect(fmtUptime(0)).toBe('0s');
});
