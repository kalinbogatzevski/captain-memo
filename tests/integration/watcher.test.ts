import { test, expect, beforeEach, afterEach } from 'bun:test';
import { FileWatcher } from '../../src/worker/watcher.ts';
import { writeFileSync, mkdtempSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmWorkDir } from '../support/worker-temp.ts';

let workDir: string;
let watcher: FileWatcher;
let events: Array<{ type: string; path: string }>;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-watch-'));
  events = [];
});

afterEach(async () => {
  if (watcher) await watcher.close();
  rmWorkDir(workDir);
});

test('FileWatcher — fires on file create', async () => {
  watcher = new FileWatcher({
    paths: [join(workDir, '*.md')],
    debounceMs: 50,
    onEvent: (type, path) => events.push({ type, path }),
  });
  await watcher.start();
  // Wait briefly for watcher to be ready
  await new Promise(r => setTimeout(r, 100));

  writeFileSync(join(workDir, 'new.md'), 'content');
  await new Promise(r => setTimeout(r, 300));

  expect(events.some(e => e.type === 'add' && e.path.endsWith('new.md'))).toBe(true);
});

test('FileWatcher — fires on file change', async () => {
  const filePath = join(workDir, 'existing.md');
  writeFileSync(filePath, 'v1');
  watcher = new FileWatcher({
    paths: [join(workDir, '*.md')],
    debounceMs: 50,
    onEvent: (type, path) => events.push({ type, path }),
  });
  await watcher.start();
  await new Promise(r => setTimeout(r, 100));
  events.length = 0; // ignore initial add

  writeFileSync(filePath, 'v2');
  await new Promise(r => setTimeout(r, 300));

  expect(events.some(e => e.type === 'change' && e.path.endsWith('existing.md'))).toBe(true);
});

test('FileWatcher — fires on file delete', async () => {
  const filePath = join(workDir, 'deletable.md');
  writeFileSync(filePath, 'will be deleted');
  watcher = new FileWatcher({
    paths: [join(workDir, '*.md')],
    debounceMs: 50,
    onEvent: (type, path) => events.push({ type, path }),
  });
  await watcher.start();
  await new Promise(r => setTimeout(r, 100));
  events.length = 0;

  unlinkSync(filePath);
  await new Promise(r => setTimeout(r, 300));

  expect(events.some(e => e.type === 'unlink' && e.path.endsWith('deletable.md'))).toBe(true);
});

// #234: a captain indexed ~/.codex/logs_2.sqlite-wal and models_cache.json as memory. `AGENTS*.md` has
// neither a leading-star extension nor an exact name, so the old pooled filter was empty and let through
// every file of the watched directory.
test('FileWatcher — a pattern with the wildcard inside the name matches only its own files', async () => {
  for (const f of ['AGENTS.md', 'logs_2.sqlite-wal', 'models_cache.json', 'auth.json', 'notes.md']) {
    writeFileSync(join(workDir, f), 'x');
  }
  watcher = new FileWatcher({
    paths: [join(workDir, 'AGENTS*.md')],
    debounceMs: 50,
    onEvent: (type, path) => events.push({ type, path }),
  });
  await watcher.start();
  writeFileSync(join(workDir, 'logs_2.sqlite-wal'), 'changed');
  writeFileSync(join(workDir, 'AGENTS.override.md'), 'new');
  await new Promise(r => setTimeout(r, 400));

  expect([...new Set(events.map(e => e.path.split('/').pop()))].sort()).toEqual(['AGENTS.md', 'AGENTS.override.md']);
});

test('FileWatcher — one pattern does not widen another directory', async () => {
  const other = mkdtempSync(join(tmpdir(), 'captain-memo-watch2-'));
  writeFileSync(join(other, 'README.md'), 'x');
  writeFileSync(join(other, 'SKILL.md'), 'x');
  writeFileSync(join(workDir, 'a.md'), 'x');
  watcher = new FileWatcher({
    paths: [join(workDir, '*.md'), join(other, 'SKILL.md')],
    debounceMs: 50,
    onEvent: (type, path) => events.push({ type, path }),
  });
  await watcher.start();
  await new Promise(r => setTimeout(r, 300));
  rmWorkDir(other);

  expect(events.map(e => e.path.split('/').pop()).sort()).toEqual(['SKILL.md', 'a.md']);
});
