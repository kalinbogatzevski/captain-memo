import { test, expect } from 'bun:test';
import { onEngineCrash, type SupervisorState } from '../../../src/worker/engine-supervisor.ts';

test('respawns while under the cap', () => {
  const s: SupervisorState = { crashes: [] };
  for (let i = 0; i < 5; i++) expect(onEngineCrash(s, 1000 + i, 5, 60_000).action).toBe('respawn');
});

test('gives up past the cap within the window', () => {
  const s: SupervisorState = { crashes: [] };
  for (let i = 0; i < 5; i++) onEngineCrash(s, 1000 + i, 5, 60_000);
  expect(onEngineCrash(s, 1010, 5, 60_000).action).toBe('give-up');
});

test('old crashes outside the window are pruned -> respawns again', () => {
  const s: SupervisorState = { crashes: [1, 2, 3, 4, 5] };
  expect(onEngineCrash(s, 1_000_000, 5, 60_000).action).toBe('respawn');
});
