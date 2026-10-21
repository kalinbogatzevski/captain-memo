// #725 (3): ONE resolution of Codex's home. connect and doctor (cli/cross-ai.ts) and the reader that looks at the same
// folder (the summarizer login probe) both go through shared/codex-home.ts.
import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { codexHomeDir } from '../../src/shared/codex-home.ts';
import { codexHomeDir as viaCrossAi } from '../../src/cli/cross-ai.ts';

const HOME = join(tmpdir(), 'cm-codex-home-fake-home');   // never touched: the helper only builds a path from it

test('codexHomeDir: unset or empty is <home>/.codex, a value is taken as given', () => {
  expect(codexHomeDir(HOME, {})).toBe(join(HOME, '.codex'));
  expect(codexHomeDir(HOME, { CODEX_HOME: '' })).toBe(join(HOME, '.codex'));      // codex reads an empty CODEX_HOME as unset
  expect(codexHomeDir(HOME, { CODEX_HOME: join(HOME, 'alt') })).toBe(join(HOME, 'alt'));
});

test('codexHomeDir: a whitespace-only CODEX_HOME is a path, not unset (codex-cli 0.159.3 refuses to start on " ")', () => {
  expect(codexHomeDir(HOME, { CODEX_HOME: ' ' })).toBe(' ');
});

test('cross-ai.ts exports the very same function (doctor and connect import it from there)', () => {
  expect(viaCrossAi).toBe(codexHomeDir);
});

// The summarizer login probe used to carry its own copy of the resolution (with a different idea of "empty").
// Behaviour is pinned by its own test; this stops the copy coming back.
test('the summarizer login probe does not resolve CODEX_HOME on its own', () => {
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'shared', 'summarizer-login.ts'), 'utf-8');
  expect(src).not.toMatch(/\.CODEX_HOME\b/);
  expect(src).toContain('codexHomeDir(');
});
