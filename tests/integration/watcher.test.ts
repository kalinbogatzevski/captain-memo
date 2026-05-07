import { test, expect, beforeEach, afterEach } from 'bun:test';
import { FileWatcher } from '../../src/worker/watcher.ts';
import { writeFileSync, mkdtempSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let workDir: string;
let watcher: FileWatcher;
let events: Array<{ type: string; path: string }>;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'aelita-watch-'));
  events = [];
});

afterEach(async () => {
  if (watcher) await watcher.close();
  rmSync(workDir, { recursive: true, force: true });
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
