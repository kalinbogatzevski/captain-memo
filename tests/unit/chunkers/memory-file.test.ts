import { test, expect } from 'bun:test';
import { chunkMemoryFile } from '../../../src/worker/chunkers/memory-file.ts';
import { readFileSync } from 'fs';

const fixture = readFileSync('tests/fixtures/memory-files/feedback_example.md', 'utf-8');

test('chunkMemoryFile — produces exactly one chunk per file', () => {
  const chunks = chunkMemoryFile(fixture, '/abs/path/feedback_example.md');
  expect(chunks).toHaveLength(1);
});

test('chunkMemoryFile — chunk text excludes frontmatter', () => {
  const [chunk] = chunkMemoryFile(fixture, '/abs/path/feedback_example.md');
  expect(chunk!.text).not.toContain('---');
  expect(chunk!.text).not.toContain('name: feedback_example');
  expect(chunk!.text).toContain('Always use erp-components');
});

test('chunkMemoryFile — metadata extracts frontmatter fields', () => {
  const [chunk] = chunkMemoryFile(fixture, '/abs/path/feedback_example.md');
  expect(chunk!.metadata.memory_type).toBe('feedback');
  expect(chunk!.metadata.description).toBe('An illustrative feedback memory for testing');
  expect(chunk!.metadata.filename_id).toBe('feedback_example');
});

test('chunkMemoryFile — handles file with no frontmatter', () => {
  const noFrontmatter = '# Plain content\n\nJust some text.';
  const chunks = chunkMemoryFile(noFrontmatter, '/abs/path/note.md');
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.text).toContain('Just some text');
  expect(chunks[0]!.metadata.memory_type).toBeUndefined();
});
