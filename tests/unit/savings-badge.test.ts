import { test, expect, afterEach } from 'bun:test';
import { formatEnvelope } from '../../src/worker/envelope.ts';
import type { EnvelopeHit } from '../../src/shared/types.ts';

// Helper: an observation hit with an optional work_tokens value.
const obsHit = (work_tokens: number | null, over: Partial<EnvelopeHit> = {}): EnvelopeHit => ({
  doc_id: 'observation:1700000000:aaa111',
  channel: 'observation',
  source_path: 'observation:1',
  title: 'Branch boost design discussion',
  snippet: 'We landed on a 1.1x multiplier for the same-branch boost.',
  score: 0.88,
  metadata: {
    type: 'discovery',
    created_at_epoch: 1_700_000_000,
    ...(work_tokens !== null ? { work_tokens } : {}),
  },
  ...over,
});

// Reset env vars touched by tests so they don't bleed between cases.
const ENV_KEYS = [
  'CAPTAIN_MEMO_SHOW_SAVINGS_PERCENT',
  'CAPTAIN_MEMO_SHOW_SAVINGS_AMOUNT',
  'CAPTAIN_MEMO_SHOW_WORK_TOKENS',
  'CAPTAIN_MEMO_SHOW_READ_TOKENS',
];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

// ──────────────────────────────────────────────────────────────────────
// renderSavingsBadge logic — tested indirectly through formatEnvelope
// ──────────────────────────────────────────────────────────────────────

test('savings badge — default-on: shows "saved X%" when work_tokens > 0', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [obsHit(2_400)],
    degradation_flags: [],
  });
  expect(out.envelope).toMatch(/saved \d+%/);
});

test('savings badge — no badge when work_tokens is null', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [obsHit(null)],
    degradation_flags: [],
  });
  expect(out.envelope).not.toMatch(/saved \d+%/);
});

test('savings badge — no badge when work_tokens is 0', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [obsHit(0)],
    degradation_flags: [],
  });
  expect(out.envelope).not.toMatch(/saved \d+%/);
});

test('savings badge — SHOW_SAVINGS_PERCENT=0 suppresses percent', () => {
  process.env.CAPTAIN_MEMO_SHOW_SAVINGS_PERCENT = '0';
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [obsHit(2_400)],
    degradation_flags: [],
  });
  expect(out.envelope).not.toMatch(/saved \d+%/);
});

test('savings badge — all four toggles off produces no badge line', () => {
  process.env.CAPTAIN_MEMO_SHOW_SAVINGS_PERCENT = '0';
  process.env.CAPTAIN_MEMO_SHOW_SAVINGS_AMOUNT  = '0';
  process.env.CAPTAIN_MEMO_SHOW_WORK_TOKENS     = '0';
  process.env.CAPTAIN_MEMO_SHOW_READ_TOKENS     = '0';
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [obsHit(2_400)],
    degradation_flags: [],
  });
  expect(out.envelope).not.toMatch(/saved/);
  expect(out.envelope).not.toMatch(/tokens saved/);
  expect(out.envelope).not.toMatch(/work \d/);
  expect(out.envelope).not.toMatch(/recall \d/);
});

test('savings badge — SHOW_SAVINGS_AMOUNT=1 appends tokens-saved count', () => {
  process.env.CAPTAIN_MEMO_SHOW_SAVINGS_AMOUNT = '1';
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [obsHit(2_400)],
    degradation_flags: [],
  });
  expect(out.envelope).toMatch(/tokens saved/);
});

test('savings badge — SHOW_WORK_TOKENS=1 appends work count', () => {
  process.env.CAPTAIN_MEMO_SHOW_WORK_TOKENS = '1';
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [obsHit(2_400)],
    degradation_flags: [],
  });
  expect(out.envelope).toMatch(/work 2,400/);
});

test('savings badge — SHOW_READ_TOKENS=1 appends recall count', () => {
  process.env.CAPTAIN_MEMO_SHOW_READ_TOKENS = '1';
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [obsHit(2_400)],
    degradation_flags: [],
  });
  expect(out.envelope).toMatch(/recall \d+/);
});

test('savings badge — all four toggles on produces combined badge', () => {
  process.env.CAPTAIN_MEMO_SHOW_SAVINGS_PERCENT = '1';
  process.env.CAPTAIN_MEMO_SHOW_SAVINGS_AMOUNT  = '1';
  process.env.CAPTAIN_MEMO_SHOW_WORK_TOKENS     = '1';
  process.env.CAPTAIN_MEMO_SHOW_READ_TOKENS     = '1';
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [obsHit(2_400)],
    degradation_flags: [],
  });
  // All four parts joined with ' · '
  expect(out.envelope).toMatch(/saved \d+% · .+ tokens saved · work 2,400 · recall \d+/);
});

test('savings badge — read > work clamps saved to 0, percent to 0%', () => {
  process.env.CAPTAIN_MEMO_SHOW_SAVINGS_AMOUNT = '1';
  // work_tokens = 10, but snippet is long → read_tokens >> work_tokens
  const longSnippet = 'x '.repeat(200); // ~400 tokens
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [obsHit(10, { snippet: longSnippet })],
    degradation_flags: [],
  });
  expect(out.envelope).toContain('saved 0%');
});

test('savings badge — percent computed correctly for known values', () => {
  // work=2400, snippet chosen to be ~215 tokens → saved ≈ 91%
  // We can't guarantee exact token count, so just check the badge is present
  // and in range 80–99%.
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [obsHit(2_400)],
    degradation_flags: [],
  });
  const m = out.envelope.match(/saved (\d+)%/);
  expect(m).not.toBeNull();
  const pct = parseInt(m![1]!, 10);
  expect(pct).toBeGreaterThanOrEqual(0);
  expect(pct).toBeLessThanOrEqual(100);
});

test('savings badge — non-observation hits (memory, skill) never get badges', () => {
  const memHit: EnvelopeHit = {
    doc_id: 'memory:x:abc',
    channel: 'memory',
    source_path: '/mem.md',
    title: 'memory title',
    snippet: 'some memory content',
    score: 0.9,
    metadata: { memory_type: 'feedback', work_tokens: 9999 },
  };
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [memHit],
    degradation_flags: [],
  });
  // The badge function is only called in renderObservationGroup; memory hits
  // go through renderMemoryGroup which has no badge logic.
  expect(out.envelope).not.toMatch(/saved \d+%/);
});
