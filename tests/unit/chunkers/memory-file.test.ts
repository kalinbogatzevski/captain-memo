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

test('chunkMemoryFile — splits multi-section files on H2 headings', () => {
  const multiSection = [
    '---', 'name: claude_md', 'type: rules', '---', '',
    'Top-level intro paragraph that sits before any heading.',
    '',
    '## Setup',
    'How to install everything.',
    '',
    '## Run',
    'How to run the dev server.',
    '',
    '## Test',
    'How to invoke the test suite.',
  ].join('\n');
  const chunks = chunkMemoryFile(multiSection, '/abs/path/CLAUDE.md');
  // 1 intro + 3 H2 sections = 4 chunks
  expect(chunks).toHaveLength(4);
  expect(chunks[0]!.metadata.section_kind).toBe('intro');
  expect(chunks[0]!.text).toContain('Top-level intro');
  expect(chunks[1]!.metadata.section_kind).toBe('h2');
  expect(chunks[1]!.metadata.section_title).toBe('Setup');
  expect(chunks[2]!.metadata.section_title).toBe('Run');
  expect(chunks[3]!.metadata.section_title).toBe('Test');
});

test('chunkMemoryFile — preserves base metadata across split sections', () => {
  const multiSection = [
    '---', 'name: foo', 'type: rules', 'description: a desc', '---', '',
    '## A', 'a content',
    '',
    '## B', 'b content',
  ].join('\n');
  const chunks = chunkMemoryFile(multiSection, '/abs/path/foo.md');
  for (const c of chunks) {
    expect(c.metadata.doc_type).toBe('memory_file');
    expect(c.metadata.filename_id).toBe('foo');
    expect(c.metadata.memory_type).toBe('rules');
    expect(c.metadata.description).toBe('a desc');
    expect(c.metadata.name).toBe('foo');
  }
});

test('chunkMemoryFile — does NOT split on ## inside code fences', () => {
  const withFence = [
    '---', 'name: foo', '---', '',
    '## Real Heading',
    'real content',
    '',
    '```markdown',
    '## This Is A Code Example',
    'not a real heading',
    '```',
    '',
    'still in the Real Heading section',
  ].join('\n');
  const chunks = chunkMemoryFile(withFence, '/abs/path/foo.md');
  // Only one H2 split (the real one); the fenced ## is part of its body.
  const h2 = chunks.filter(c => c.metadata.section_kind === 'h2');
  expect(h2).toHaveLength(1);
  expect(h2[0]!.metadata.section_title).toBe('Real Heading');
  expect(h2[0]!.text).toContain('## This Is A Code Example');
  expect(h2[0]!.text).toContain('still in the Real Heading section');
});

test('chunkMemoryFile — skips intro chunk when body starts with a heading', () => {
  const noIntro = [
    '---', 'name: foo', '---', '',
    '## First Heading',
    'first content',
    '',
    '## Second Heading',
    'second content',
  ].join('\n');
  const chunks = chunkMemoryFile(noIntro, '/abs/path/foo.md');
  // No intro section emitted — only the two H2 sections
  expect(chunks).toHaveLength(2);
  expect(chunks.every(c => c.metadata.section_kind === 'h2')).toBe(true);
});
