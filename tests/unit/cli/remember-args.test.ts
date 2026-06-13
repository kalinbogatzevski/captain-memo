import { test, expect } from 'bun:test';
import { parseRememberArgs, readBody } from '../../../src/cli/commands/remember.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

test('parseRememberArgs — collects type/name/description/slug flags', () => {
  const r = parseRememberArgs([
    '--type', 'decision',
    '--name', 'Use Bun',
    '--description', 'We standardized on Bun',
    '--slug', 'use-bun',
    '--body', 'Bun is the runtime.',
  ]);
  expect(r.type).toBe('decision');
  expect(r.name).toBe('Use Bun');
  expect(r.description).toBe('We standardized on Bun');
  expect(r.slug).toBe('use-bun');
  expect(r.bodyInline).toBe('Bun is the runtime.');
  expect(r.file).toBeUndefined();
});

test('parseRememberArgs — --file records the path, not the contents', () => {
  const r = parseRememberArgs(['--type', 'reference', '--file', '/tmp/note.md']);
  expect(r.file).toBe('/tmp/note.md');
  expect(r.bodyInline).toBeUndefined();
});

test('parseRememberArgs — no body flag leaves bodyInline and file undefined (stdin fallback)', () => {
  const r = parseRememberArgs(['--type', 'feedback']);
  expect(r.bodyInline).toBeUndefined();
  expect(r.file).toBeUndefined();
});

test('parseRememberArgs — missing --type throws (type is required)', () => {
  expect(() => parseRememberArgs(['--body', 'x'])).toThrow(/--type/);
});

test('parseRememberArgs — unknown flag throws', () => {
  expect(() => parseRememberArgs(['--type', 'decision', '--bogus', 'x'])).toThrow(/--bogus/);
});

test('parseRememberArgs — --body and --file together throws (one body source)', () => {
  expect(() => parseRememberArgs(['--type', 'decision', '--body', 'x', '--file', '/tmp/y'])).toThrow(/--body.*--file|one body/i);
});

test('readBody — inline --body wins and is returned verbatim', async () => {
  const out = await readBody({ type: 'decision', bodyInline: 'inline text' });
  expect(out).toBe('inline text');
});

test('readBody — --file reads the file contents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-remember-'));
  const fp = join(dir, 'note.md');
  writeFileSync(fp, '# A decision\nbody from file');
  try {
    const out = await readBody({ type: 'decision', file: fp });
    expect(out).toBe('# A decision\nbody from file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readBody — missing --file path throws an actionable error', async () => {
  await expect(readBody({ type: 'decision', file: '/no/such/path-xyz.md' })).rejects.toThrow(/no\/such\/path-xyz\.md|read|file/i);
});
