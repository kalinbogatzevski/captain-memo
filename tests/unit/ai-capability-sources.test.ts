import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { allCapabilitySources, discoverCapabilityGlobs, resolveCapabilityWatchSetting } from '../../src/shared/ai-capability-sources.ts';

test('capability watching defaults to auto but explicit empty opts out', () => {
  expect(resolveCapabilityWatchSetting(undefined)).toBe('auto');
  expect(resolveCapabilityWatchSetting('auto')).toBe('auto');
  expect(resolveCapabilityWatchSetting('')).toBe('');
});

test('capability discovery uses known manifest names only', () => {
  const sources = allCapabilitySources('/home/tester');
  expect(sources.length).toBeGreaterThan(0);
  for (const source of sources) {
    expect(['plugin.json', 'gemini-extension.json']).toContain(basename(source.glob));
  }
});

test('capability auto-discovery includes installed runtime roots', () => {
  const home = mkdtempSync(join(tmpdir(), 'captain-cap-home-'));
  mkdirSync(join(home, '.gemini', 'extensions'), { recursive: true });
  const globs = discoverCapabilityGlobs(home);
  expect(globs).toContain(join(home, '.gemini', 'extensions', '*', 'gemini-extension.json'));
  expect(globs.some(g => g.split(/[\\/]/).includes('.codex'))).toBe(false);
});

test('codex plugin manifests are discovered in ~/.codex (or $CODEX_HOME, which replaces it)', () => {
  const home = mkdtempSync(join(tmpdir(), 'captain-cap-home-'));
  const codexGlob = (env: Record<string, string>) => allCapabilitySources(home, env).filter((s) => s.tool === 'codex').map((s) => s.glob);
  const rest = ['plugins', 'cache', '*', '*', '*', '.codex-plugin', 'plugin.json'];
  expect(codexGlob({})).toEqual([join(home, '.codex', ...rest)]);
  expect(codexGlob({ CODEX_HOME: '' })).toEqual(codexGlob({}));                     // blank = unset
  const alt = join(home, 'codex-alt');
  expect(codexGlob({ CODEX_HOME: alt })).toEqual([join(alt, ...rest)]);
  mkdirSync(join(alt, 'plugins', 'cache'), { recursive: true });
  expect(discoverCapabilityGlobs(home, { CODEX_HOME: alt })).toEqual([join(alt, ...rest)]);
  expect(discoverCapabilityGlobs(home, {})).toEqual([]);                            // ~/.codex has no plugins here
});
