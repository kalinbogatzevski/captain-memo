// tests/unit/home-of.test.ts
//
// `getent` is a glibc tool. macOS ships no usable one, so `getent passwd $USER` returned
// empty there and the install wizard resolved every derived path against "" — reported
// from the field on macOS 2026-07-28, where it broke the wizard outright.
//
// The fix is not a darwin ternary at each call site (there were four) but one helper
// that avoids the subprocess entirely for the case that actually occurs: resolving the
// home of the user we are already running as.

import { test, expect } from 'bun:test';
import { homedir, userInfo } from 'os';
import { homeOf } from '../../src/shared/platform.ts';

test('no argument resolves the current user, with no subprocess', () => {
  expect(homeOf()).toBe(homedir());
});

test('naming the CURRENT user takes the same subprocess-free path', () => {
  // This is the case the installer hits on every non-sudo run, and the one that was
  // being answered by shelling out to a tool that does not exist on macOS.
  expect(homeOf(userInfo().username)).toBe(homedir());
});

test('an empty username is treated as "me", never as a lookup', () => {
  // SUDO_USER and USER can both be unset in a container; looking up "" returned an
  // empty home, which then silently poisoned every path built from it.
  expect(homeOf('')).toBe(homedir());
  expect(homeOf(undefined)).toBe(homedir());
});

test('an unknown user yields a conventional path, never an empty string', () => {
  // Whatever the platform answers, the contract is that the result is usable: an empty
  // string is the one return value that corrupts callers instead of failing them.
  const h = homeOf('definitely-not-a-real-user-9f3a2b');
  expect(h.length).toBeGreaterThan(1);
  expect(h.startsWith('/')).toBe(true);
});
