import { test, expect } from 'bun:test';
import { loadQmConfig, DEFAULT_QM_CONFIG } from '../../src/worker/qm.ts';

test('loadQmConfig — supersedeEnabled defaults ON and toggles off on CAPTAIN_MEMO_QM_SUPERSEDE=0', () => {
  expect(DEFAULT_QM_CONFIG.supersedeEnabled).toBe(true);
  expect(loadQmConfig({}).supersedeEnabled).toBe(true);
  expect(loadQmConfig({ CAPTAIN_MEMO_QM_SUPERSEDE: '1' }).supersedeEnabled).toBe(true);
  expect(loadQmConfig({ CAPTAIN_MEMO_QM_SUPERSEDE: '0' }).supersedeEnabled).toBe(false);
});

// The semantic window is SEPARATE from dedupWindow. They were shared, and the shared 5,000
// crippled the semantic pass: measured on the live 135k corpus it found 0 groups at 5,000 and
// 82 at full population, because duplicates are same-session and a global recency slice across
// 143 projects leaves no session with two rows in the window.
test('semanticWindow defaults wide and is independent of dedupWindow', () => {
  const d = loadQmConfig({});
  expect(d.dedupWindow).toBe(5_000);
  expect(d.semanticWindow).toBe(50_000);

  const tuned = loadQmConfig({ CAPTAIN_MEMO_QM_DEDUP_WINDOW: '1000' });
  expect(tuned.dedupWindow).toBe(1_000);
  expect(tuned.semanticWindow).toBe(50_000);      // narrowing dedup must not narrow this one

  expect(loadQmConfig({ CAPTAIN_MEMO_QM_SEMANTIC_WINDOW: '2500' }).semanticWindow).toBe(2_500);
});
