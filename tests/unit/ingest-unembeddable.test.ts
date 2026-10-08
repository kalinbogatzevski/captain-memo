import { test, expect } from 'bun:test';
import { isUnembeddableChunk } from '../../src/worker/ingest.ts';

// The retry queue must drop a row like these instead of sending it again: on one captain 260 chunks of Codex's
// own database files were retried 68,043 times and cost 7.29M Voyage tokens in a morning (2026-10-08).
test('a chunk of a non-markdown file indexed as memory is never embedded', () => {
  expect(isUnembeddableChunk('memory', '/home/x/.codex/logs_2.sqlite-wal', 'plain looking text')).toBe(true);
  expect(isUnembeddableChunk('memory', '/home/x/.codex/models_cache.json', '{"a":1}')).toBe(true);
});

test('a chunk holding a NUL byte is binary and never embedded, whatever its channel', () => {
  expect(isUnembeddableChunk('observation', 'observation:p:1', 'abc\0def')).toBe(true);
});

test('ordinary memory, skill and observation chunks pass', () => {
  expect(isUnembeddableChunk('memory', '/home/x/.claude/projects/p/memory/a.md', '# note')).toBe(false);
  expect(isUnembeddableChunk('memory', '/home/x/.cursor/rules/a.MDC', 'rule')).toBe(false);
  expect(isUnembeddableChunk('skill', '/home/x/skills/s/SKILL.md', 'steps')).toBe(false);
  expect(isUnembeddableChunk('observation', 'observation:p:2', 'a normal narrative')).toBe(false);
});
