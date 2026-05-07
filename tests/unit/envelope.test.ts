import { test, expect } from 'bun:test';
import { formatEnvelope } from '../../src/worker/envelope.ts';
import type { EnvelopeHit } from '../../src/shared/types.ts';

const memoryHit = (over: Partial<EnvelopeHit> = {}): EnvelopeHit => ({
  doc_id: 'memory:feedback_no_null:abc123',
  channel: 'memory',
  source_path: '/home/k/.claude/memory/feedback_no_null.md',
  title: 'feedback_no_null',
  snippet: 'No NULL — use 0 / "" sentinels.',
  score: 0.87,
  metadata: { memory_type: 'feedback' },
  ...over,
});

const skillHit = (over: Partial<EnvelopeHit> = {}): EnvelopeHit => ({
  doc_id: 'skill:erp-coding-standards#sql:def456',
  channel: 'skill',
  source_path: '/home/k/.claude/skills/erp-coding-standards/SKILL.md',
  title: 'erp-coding-standards / sql',
  snippet: 'Always use db_get_row() for single-row reads.',
  score: 0.81,
  metadata: { skill_id: 'erp-coding-standards', section_title: 'sql' },
  ...over,
});

const obsHit = (over: Partial<EnvelopeHit> = {}): EnvelopeHit => ({
  doc_id: 'observation:1700000000:ghi789',
  channel: 'observation',
  source_path: 'observation:1',
  title: 'fixed billing rounding',
  snippet: 'replaced round() with full-precision intermediate.',
  score: 0.74,
  metadata: { type: 'bugfix', created_at_epoch: 1_700_000_000 },
  ...over,
});

test('formatEnvelope — empty hits emits empty-state envelope with hit_count=0', () => {
  const out = formatEnvelope({
    project_id: 'erp-platform',
    budget_tokens: 4000,
    hits: [],
    degradation_flags: [],
  });
  expect(out.envelope).toContain('<memory-context');
  expect(out.envelope).toContain('project="erp-platform"');
  expect(out.envelope).toContain('k="0"');
  expect(out.envelope).toContain('</memory-context>');
  expect(out.hit_count).toBe(0);
});

test('formatEnvelope — groups hits by channel in fixed order memory, skill, observation', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [obsHit(), memoryHit(), skillHit()],
    degradation_flags: [],
  });
  const idxMem = out.envelope.indexOf('Local memory');
  const idxSkill = out.envelope.indexOf('Skill: ');
  const idxObs = out.envelope.indexOf('Session memory');
  expect(idxMem).toBeGreaterThan(0);
  expect(idxSkill).toBeGreaterThan(idxMem);
  expect(idxObs).toBeGreaterThan(idxSkill);
});

test('formatEnvelope — emits get_full hint with the doc_id verbatim', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [memoryHit()],
    degradation_flags: [],
  });
  expect(out.envelope).toContain('[full: get_full("memory:feedback_no_null:abc123")]');
});

test('formatEnvelope — score is rendered to two decimals', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [memoryHit({ score: 0.87543 })],
    degradation_flags: [],
  });
  expect(out.envelope).toContain('score 0.88');
});

test('formatEnvelope — degradation flags render in the opening tag', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [memoryHit()],
    degradation_flags: ['embedder=voyage-4-nano:keyword-fallback=true'],
  });
  expect(out.envelope).toContain('embedder=voyage-4-nano:keyword-fallback=true');
});

test('formatEnvelope — used_tokens never exceeds budget_tokens', () => {
  const bigSnippet = 'x'.repeat(20_000);
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 200,
    hits: [memoryHit({ snippet: bigSnippet })],
    degradation_flags: [],
  });
  expect(out.used_tokens).toBeLessThanOrEqual(200);
});

test('formatEnvelope — observation hit shows type and date prefix', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [obsHit()],
    degradation_flags: [],
  });
  // "bugfix · 2023-11-14" (epoch 1_700_000_000 = 2023-11-14 UTC)
  expect(out.envelope).toMatch(/bugfix · 2023-11-14/);
});
