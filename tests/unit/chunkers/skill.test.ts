import { test, expect } from 'bun:test';
import { chunkSkill } from '../../../src/worker/chunkers/skill.ts';
import { readFileSync } from 'fs';

const fixture = readFileSync('tests/fixtures/skills/example-skill.md', 'utf-8');

test('chunkSkill — splits on ## headers', () => {
  const chunks = chunkSkill(fixture, '/abs/path/example-skill.md');
  // Expect: 1 summary chunk + 3 ## sections (Architecture, Usage, Anti-patterns)
  // Section headers should match
  const sectionTitles = chunks
    .filter(c => c.metadata.doc_type === 'skill_section')
    .map(c => c.metadata.section_title);
  expect(sectionTitles).toEqual(['Architecture', 'Usage', 'Anti-patterns']);
});

test('chunkSkill — produces a skill_summary chunk', () => {
  const chunks = chunkSkill(fixture, '/abs/path/example-skill.md');
  const summary = chunks.find(c => c.metadata.doc_type === 'skill_summary');
  expect(summary).toBeDefined();
  expect(summary!.text).toContain('A test skill with multiple sections');
});

test('chunkSkill — keeps code blocks intact within section', () => {
  const chunks = chunkSkill(fixture, '/abs/path/example-skill.md');
  const arch = chunks.find(c => c.metadata.section_title === 'Architecture');
  expect(arch).toBeDefined();
  expect(arch!.text).toContain('```typescript');
  expect(arch!.text).toContain('return input.toUpperCase()');
  expect(arch!.metadata.has_code).toBe(true);
});

test('chunkSkill — metadata identifies skill', () => {
  const chunks = chunkSkill(fixture, '/abs/path/example-skill.md');
  for (const chunk of chunks) {
    expect(chunk.metadata.skill_id).toBe('example-skill');
    expect(chunk.metadata.source_path).toBe('/abs/path/example-skill.md');
  }
});

test('chunkSkill — preserves position ordering', () => {
  const chunks = chunkSkill(fixture, '/abs/path/example-skill.md');
  for (let i = 1; i < chunks.length; i++) {
    expect(chunks[i]!.position).toBeGreaterThan(chunks[i - 1]!.position);
  }
});
