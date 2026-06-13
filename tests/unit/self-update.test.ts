import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  compareSemver, decideUpdateAction, formatUpgradeBanner,
  readMarker, writeMarker, consumeUpgradeNotice, MARKER_FILENAME,
} from '../../src/shared/self-update.ts';

test('compareSemver — numeric major.minor.patch, not lexical', () => {
  expect(compareSemver('0.9.0', '0.8.0')).toBe(1);
  expect(compareSemver('0.8.0', '0.9.0')).toBe(-1);
  expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  expect(compareSemver('0.10.0', '0.9.0')).toBe(1); // numeric, not '0.10' < '0.9'
  expect(compareSemver('0.9.1', '0.9.0')).toBe(1);
});

test('compareSemver — tolerates v prefix and pre-release/build suffixes', () => {
  expect(compareSemver('v0.9.0', '0.9.0')).toBe(0);
  expect(compareSemver('0.9.0-beta.1', '0.9.0')).toBe(0);
  expect(compareSemver('1.0.0+build9', '1.0.0')).toBe(0);
});

test('decideUpdateAction — null=first-run; newer=upgraded; same/older otherwise', () => {
  expect(decideUpdateAction('0.9.0', null)).toBe('first-run');
  expect(decideUpdateAction('0.9.0', '0.8.0')).toBe('upgraded');
  expect(decideUpdateAction('0.9.0', '0.9.0')).toBe('same-or-older');
  expect(decideUpdateAction('0.8.0', '0.9.0')).toBe('same-or-older');
});

test('formatUpgradeBanner — names both versions', () => {
  const b = formatUpgradeBanner('0.8.0', '0.9.0');
  expect(b).toContain('0.8.0');
  expect(b).toContain('0.9.0');
  expect(b.toLowerCase()).toContain('upgrad');
});

test('marker I/O — missing reads null; round-trips; blank reads null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-su-'));
  try {
    expect(readMarker(dir)).toBeNull();
    writeMarker(dir, '0.9.0');
    expect(existsSync(join(dir, MARKER_FILENAME))).toBe(true);
    expect(readMarker(dir)).toBe('0.9.0');
    writeFileSync(join(dir, MARKER_FILENAME), '   \n');
    expect(readMarker(dir)).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('consumeUpgradeNotice — first run is silent + writes marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-su-'));
  try {
    expect(consumeUpgradeNotice(dir, '0.9.0')).toBe('');
    expect(readMarker(dir)).toBe('0.9.0');
    expect(consumeUpgradeNotice(dir, '0.9.0')).toBe(''); // unchanged → silent
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('consumeUpgradeNotice — a version bump announces + advances the marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-su-'));
  try {
    consumeUpgradeNotice(dir, '0.8.0');                // seed marker
    const notice = consumeUpgradeNotice(dir, '0.9.0'); // upgrade
    expect(notice).toContain('0.8.0');
    expect(notice).toContain('0.9.0');
    expect(readMarker(dir)).toBe('0.9.0');
    expect(consumeUpgradeNotice(dir, '0.9.0')).toBe(''); // re-run same → silent
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('consumeUpgradeNotice — a downgrade is silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-su-'));
  try {
    consumeUpgradeNotice(dir, '0.9.0');
    expect(consumeUpgradeNotice(dir, '0.8.0')).toBe('');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
