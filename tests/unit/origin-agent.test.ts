import { test, expect } from 'bun:test';
import { detectOriginAgent, asOriginAgent, ORIGIN_AGENTS, type OriginAgent } from '../../src/shared/origin-agent.ts';

test('detectOriginAgent — CLAUDECODE=1 → claude-code', () => {
  expect(detectOriginAgent({ CLAUDECODE: '1' })).toBe('claude-code');
});

test('detectOriginAgent — CLAUDE_CODE_ENTRYPOINT set → claude-code', () => {
  expect(detectOriginAgent({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('claude-code');
});

test('detectOriginAgent — empty env bag → unknown', () => {
  expect(detectOriginAgent({})).toBe('unknown');
});

test('detectOriginAgent — explicit AI_AGENT wins for each known vendor', () => {
  expect(detectOriginAgent({ AI_AGENT: 'codex' })).toBe('codex');
  expect(detectOriginAgent({ AI_AGENT: 'cursor' })).toBe('cursor');
  expect(detectOriginAgent({ AI_AGENT: 'gemini' })).toBe('gemini');
  expect(detectOriginAgent({ AI_AGENT: 'claude-code' })).toBe('claude-code');
  expect(detectOriginAgent({ AI_AGENT: 'opencode' })).toBe('opencode');
  expect(detectOriginAgent({ AI_AGENT: 'vibe' })).toBe('vibe');
  expect(detectOriginAgent({ AI_AGENT: 'vscode' })).toBe('vscode');
  expect(detectOriginAgent({ AI_AGENT: 'jetbrains' })).toBe('jetbrains');
});

test('detectOriginAgent — AI_AGENT is normalized (case / surrounding whitespace)', () => {
  expect(detectOriginAgent({ AI_AGENT: '  Codex ' })).toBe('codex');
  expect(detectOriginAgent({ AI_AGENT: 'GEMINI' })).toBe('gemini');
});

test('detectOriginAgent — unrecognized AI_AGENT falls through to other signals', () => {
  expect(detectOriginAgent({ AI_AGENT: 'totally-made-up', CLAUDECODE: '1' })).toBe('claude-code');
  expect(detectOriginAgent({ AI_AGENT: 'totally-made-up' })).toBe('unknown');
});

test('detectOriginAgent — AI_AGENT takes precedence over CLAUDECODE when both are known', () => {
  expect(detectOriginAgent({ AI_AGENT: 'codex', CLAUDECODE: '1' })).toBe('codex');
});

test('detectOriginAgent — CLAUDECODE present but empty-string is not treated as claude-code', () => {
  expect(detectOriginAgent({ CLAUDECODE: '' })).toBe('unknown');
});

test('detectOriginAgent — always returns a member of the closed ORIGIN_AGENTS set', () => {
  const cases: Array<Record<string, string | undefined> | undefined> = [
    undefined, {}, { AI_AGENT: '' }, { CLAUDECODE: '' }, { AI_AGENT: 'xyz' },
    { CLAUDECODE: '1' }, { AI_AGENT: 'gemini' },
  ];
  for (const env of cases) {
    const got: OriginAgent = detectOriginAgent(env);
    expect(ORIGIN_AGENTS).toContain(got);
  }
});

test('asOriginAgent — narrows a valid string, rejects invalid/non-string values', () => {
  expect(asOriginAgent('codex')).toBe('codex');
  expect(asOriginAgent('unknown')).toBe('unknown');
  expect(asOriginAgent('not-a-vendor')).toBeNull();
  expect(asOriginAgent(null)).toBeNull();
  expect(asOriginAgent(undefined)).toBeNull();
  expect(asOriginAgent(42)).toBeNull();
});
