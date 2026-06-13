import { test, expect } from 'bun:test';
import {
  renderFrontmatter, deterministicFrontmatter, slugify, prefixForType,
  resolveTargetDir, fillFrontmatter, writeMemory, findUpdateTarget,
} from '../../src/worker/memory-writer.ts';
import { chunkMemoryFile } from '../../src/worker/chunkers/memory-file.ts';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { mock } from 'bun:test';

const noopIngest = { indexFile: mock(async () => {}) } as any;

test('renderFrontmatter — round-trips through chunkMemoryFile', () => {
  const doc = renderFrontmatter(
    { name: 'Use bun test', description: 'always run bun test', type: 'decision' },
    'Body line one.\n\n## A section\ndetails',
  );
  const chunks = chunkMemoryFile(doc, '/x/decision_use-bun-test.md');
  const meta = chunks[0]!.metadata as Record<string, unknown>;
  expect(meta.name).toBe('Use bun test');
  expect(meta.description).toBe('always run bun test');
  expect(meta.memory_type).toBe('decision');
  expect(chunks.some(c => (c.metadata as Record<string, unknown>).section_title === 'A section')).toBe(true);
});

test('deterministicFrontmatter — name=first non-empty line, type=given, slug=slugified', () => {
  const fm = deterministicFrontmatter(
    '\n\n  Prefer pnpm over npm here  \nmore detail follows on the next lines',
    'preference',
  );
  expect(fm.name).toBe('Prefer pnpm over npm here');
  expect(fm.type).toBe('preference');
  expect(fm.slug).toBe('prefer-pnpm-over-npm-here');
  expect(fm.description.length).toBeGreaterThan(0);
});

test('deterministicFrontmatter — truncates an overlong first line for name', () => {
  const long = 'x'.repeat(300);
  const fm = deterministicFrontmatter(long, 'reference');
  expect(fm.name.length).toBeLessThanOrEqual(120);
});

test('slugify — lowercases, dashes non-alnum, trims edges, no doubles', () => {
  expect(slugify('  Use Bun, Not Node!! ')).toBe('use-bun-not-node');
  expect(slugify('123net_aelita')).toBe('123net-aelita');
});

test('prefixForType — maps known types, falls back to the type itself', () => {
  expect(prefixForType('preference')).toBe('feedback');
  expect(prefixForType('feedback')).toBe('feedback');
  expect(prefixForType('decision')).toBe('decision');
  expect(prefixForType('reference')).toBe('reference');
  expect(prefixForType('wild')).toBe('wild');
});

test('resolveTargetDir — targetDirOverride wins', () => {
  expect(resolveTargetDir(
    { body: 'b', type: 'decision', projectContext: { cwd: '/some/where' }, targetDirOverride: '/override/dir' },
    '/default/remember',
  )).toBe('/override/dir');
});

test('resolveTargetDir — cwd -> ~/.claude/projects/<slug>/memory', () => {
  expect(resolveTargetDir(
    { body: 'b', type: 'decision', projectContext: { cwd: '/home/kalin/projects/captain-memo' } },
    '/default/remember',
  )).toBe(join(homedir(), '.claude', 'projects', '-home-kalin-projects-captain-memo', 'memory'));
});

test('resolveTargetDir — no cwd -> rememberDir default', () => {
  expect(resolveTargetDir(
    { body: 'b', type: 'decision', projectContext: {} },
    '/default/remember',
  )).toBe('/default/remember');
});

test('fillFrontmatter — uses caller overrides verbatim, no generate call', async () => {
  const generate = mock(async () => { throw new Error('should not be called'); });
  const fm = await fillFrontmatter(
    { body: 'b', type: 'decision', name: 'N', description: 'D', slug: 's', projectContext: {} },
    generate as any,
  );
  expect(fm).toEqual({ name: 'N', description: 'D', slug: 's', type: 'decision' });
  expect(generate).not.toHaveBeenCalled();
});

test('fillFrontmatter — calls generate when a field is missing', async () => {
  const generate = mock(async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify({
      name: 'Gen Name', description: 'gen desc', slug: 'gen-name', type: 'decision',
    }) }],
    model: 'claude-haiku-4-5',
  }));
  const fm = await fillFrontmatter(
    { body: 'pick bun', type: 'decision', projectContext: {} },
    generate as any,
  );
  expect(generate).toHaveBeenCalledTimes(1);
  expect(fm.name).toBe('Gen Name');
  expect(fm.slug).toBe('gen-name');
});

test('fillFrontmatter — generate throws -> deterministic fallback', async () => {
  const generate = mock(async () => { throw new Error('transport offline'); });
  const fm = await fillFrontmatter(
    { body: 'Prefer pnpm here\nmore', type: 'preference', projectContext: {} },
    generate as any,
  );
  expect(generate).toHaveBeenCalledTimes(1);
  expect(fm.name).toBe('Prefer pnpm here');
  expect(fm.slug).toBe('prefer-pnpm-here');
  expect(fm.type).toBe('preference');
});

test('writeMemory — mkdirs the resolved target dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-mw-'));
  const target = join(dir, 'nested', 'memory');
  const generate = mock(async () => { throw new Error('offline'); });
  const res = await writeMemory(
    { body: 'a note worth keeping', type: 'reference', projectContext: {}, targetDirOverride: target },
    {
      ingest: noopIngest,
      embed: mock(async () => { throw new Error('embedder offline'); }) as any,
      searchMemory: mock(async () => []) as any,
      generate: generate as any,
      registerSelfWrite: mock(() => {}),
      rememberDir: dir,
      dedupThreshold: 0.85,
    },
  );
  expect(res.ok).toBe(true);
  expect(existsSync(target)).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test('findUpdateTarget — filename collision -> that file, embedder never queried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-dd-'));
  const existing = join(dir, 'decision_use-bun.md');
  writeFileSync(existing, '---\nname: x\ntype: decision\n---\nold');
  const embed = mock(async () => { throw new Error('must not embed'); });
  const searchMemory = mock(async () => []);
  const target = await findUpdateTarget(
    'use bun', dir, 'decision_use-bun.md',
    { embed: embed as any, searchMemory: searchMemory as any, dedupThreshold: 0.85 },
  );
  expect(target).toBe(existing);
  expect(embed).not.toHaveBeenCalled();
  rmSync(dir, { recursive: true, force: true });
});

test('findUpdateTarget — semantic hit >= threshold in dir -> that file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-dd-'));
  const hitPath = join(dir, 'reference_existing.md');
  writeFileSync(hitPath, '---\nname: y\ntype: reference\n---\nbody');
  const embed = mock(async () => [[0.1, 0.2]]);
  const searchMemory = mock(async () => [{ source_path: hitPath, score: 0.91, chunk_id: 'memory:reference_existing:aa' }]);
  const target = await findUpdateTarget(
    'similar body', dir, 'reference_new.md',
    { embed: embed as any, searchMemory: searchMemory as any, dedupThreshold: 0.85 },
  );
  expect(embed).toHaveBeenCalledTimes(1);
  expect(target).toBe(hitPath);
  rmSync(dir, { recursive: true, force: true });
});

test('findUpdateTarget — semantic hit below threshold -> null (create)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-dd-'));
  const embed = mock(async () => [[0.1]]);
  const searchMemory = mock(async () => [{ source_path: join(dir, 'reference_x.md'), score: 0.4, chunk_id: 'c' }]);
  const target = await findUpdateTarget(
    'unique', dir, 'reference_new.md',
    { embed: embed as any, searchMemory: searchMemory as any, dedupThreshold: 0.85 },
  );
  expect(target).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test('findUpdateTarget — semantic hit OUTSIDE target dir is ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-dd-'));
  const embed = mock(async () => [[0.1]]);
  const searchMemory = mock(async () => [{ source_path: '/elsewhere/reference_x.md', score: 0.99, chunk_id: 'c' }]);
  const target = await findUpdateTarget(
    'x', dir, 'reference_new.md',
    { embed: embed as any, searchMemory: searchMemory as any, dedupThreshold: 0.85 },
  );
  expect(target).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test('findUpdateTarget — embedder failure skips semantic dedup, returns null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-dd-'));
  const embed = mock(async () => { throw new Error('embedder offline'); });
  const searchMemory = mock(async () => []);
  const target = await findUpdateTarget(
    'x', dir, 'reference_new.md',
    { embed: embed as any, searchMemory: searchMemory as any, dedupThreshold: 0.85 },
  );
  expect(target).toBeNull();
  expect(searchMemory).not.toHaveBeenCalled();
  rmSync(dir, { recursive: true, force: true });
});
