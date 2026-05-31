import { test, expect } from 'bun:test';
import { parseInstallOptions } from '../../src/cli/commands/install.ts';

// Pass an empty env so the host's CAPTAIN_MEMO_* vars can't leak into the result.
const noEnv = {} as NodeJS.ProcessEnv;

test('parseInstallOptions — --no-grant-permissions sets noGrantPermissions', () => {
  expect(parseInstallOptions(['--no-grant-permissions'], noEnv).noGrantPermissions).toBe(true);
});

test('parseInstallOptions — absent flag leaves noGrantPermissions falsy (grant is the default)', () => {
  expect(parseInstallOptions([], noEnv).noGrantPermissions).toBeFalsy();
});
