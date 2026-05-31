import { test, expect } from 'bun:test';
import { pluginRegistrationSteps } from '../../src/cli/commands/install.ts';

// Locks in the v0.2.8 cache-refresh fix, which was otherwise untestable because
// it only manifested as a live `claude` spawn. pluginRegistrationSteps() is the
// pure contract: the REMOVE must precede the ADD (a bare `add` is a no-op on an
// existing directory-marketplace entry, so without the remove the cache stays
// frozen — the exact regression that shipped a dead hook path).
test('pluginRegistrationSteps — remove precedes add precedes install', () => {
  const steps = pluginRegistrationSteps('/repo/root');
  expect(steps[0]).toEqual(['plugin', 'marketplace', 'remove', 'captain-memo', '--scope', 'user']);
  expect(steps[1]).toEqual(['plugin', 'marketplace', 'add', '/repo/root']);
  expect(steps[2]).toEqual(['plugin', 'install', 'captain-memo@captain-memo']);

  const removeIdx = steps.findIndex((s) => s.includes('remove'));
  const addIdx = steps.findIndex((s) => s.includes('add'));
  expect(removeIdx).toBeGreaterThanOrEqual(0);
  expect(removeIdx).toBeLessThan(addIdx);
});

// The remove must be user-scoped: an unscoped `marketplace remove` deletes the
// declaration from EVERY scope, silently migrating a deliberately project/local
// -scoped install to user scope on the next upgrade.
test('pluginRegistrationSteps — remove is user-scoped (never wipes a project/local declaration)', () => {
  const remove = pluginRegistrationSteps('/x').find((s) => s.includes('remove'))!;
  expect(remove).toContain('--scope');
  expect(remove[remove.indexOf('--scope') + 1]).toBe('user');
});

// The add must point at the passed repo root (the directory marketplace source).
test('pluginRegistrationSteps — add targets the given repo root', () => {
  expect(pluginRegistrationSteps('/some/where')[1]).toEqual(['plugin', 'marketplace', 'add', '/some/where']);
});
