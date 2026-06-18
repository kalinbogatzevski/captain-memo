import { test, expect } from 'bun:test';
import { parseVersion, compareVersion } from '../../src/worker/version-parse.ts';

test('parseVersion — extracts clean 3-component semver with v-prefix', () => {
  const r = parseVersion('talq v0.51.12');
  expect(r).not.toBeNull();
  expect(r!.version).toMatchObject({ major: 0, minor: 51, patch: 12, raw: 'v0.51.12' });
  expect(r!.entityKey).toBe('talq');
});

test('parseVersion — 2-component version defaults patch to 0', () => {
  const r = parseVersion('bumped to 2.0');
  expect(r!.version).toMatchObject({ major: 2, minor: 0, patch: 0 });
  expect(r!.entityKey).toBe('bumped');
});

test('parseVersion — pre-release / build suffix returns null', () => {
  expect(parseVersion('v1.2.3-beta.1 release')).toBeNull();
  expect(parseVersion('1.2.0+build5 thing')).toBeNull();
});

test('parseVersion — no dotted version returns null (bare integer is not a version)', () => {
  expect(parseVersion('react 18 hooks')).toBeNull();
  expect(parseVersion('no version here')).toBeNull();
});

test('parseVersion — empty entity key (only a version) returns null', () => {
  expect(parseVersion('v1.2.3')).toBeNull();
});

test('parseVersion — same entityKey for differing dotted versions of same subject', () => {
  const a = parseVersion('react 18.0 hooks');
  const b = parseVersion('react 19.0 hooks');
  expect(a!.entityKey).toBe(b!.entityKey);
  expect(a!.entityKey).toBe('hooks react'); // significant tokens, sorted, version span removed
});

test('compareVersion — numeric component ordering (not string)', () => {
  expect(compareVersion(parseVersion('pkg 0.6.0')!.version, parseVersion('pkg 0.51.12')!.version)).toBeLessThan(0);
  expect(compareVersion(parseVersion('pkg 1.2.0')!.version, parseVersion('pkg 1.20.0')!.version)).toBeLessThan(0);
  expect(compareVersion(parseVersion('pkg 2.0.0')!.version, parseVersion('pkg 2.0.0')!.version)).toBe(0);
});
