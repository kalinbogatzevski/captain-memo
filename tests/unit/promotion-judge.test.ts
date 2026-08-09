import { test, expect } from 'bun:test';
import { buildPromotionJudge, DEFAULT_JUDGE_MAX_TOKENS } from '../../src/worker/promotion-judge.ts';
import type { SummarizerTransport } from '../../src/worker/summarizer.ts';
import type { Observation } from '../../src/shared/types.ts';

function obs(id: number): Observation {
  return {
    id, session_id: 's', project_id: 'default', prompt_number: 1,
    type: 'decision', title: `title ${id}`, narrative: `narrative ${id}`,
    facts: [`fact ${id}`], concepts: ['c'], files_read: [], files_modified: [],
    created_at_epoch: 1_700_000_000, branch: null, origin_agent: null, work_tokens: null, stored_tokens: null,
    retrieval_count: 0, last_retrieved_at: null,
    from_auto: 0, from_search: 1, from_drill: 0,
    last_surfaced_at: null, last_surfaced_source: null,
    archived: false, archived_into_theme_id: null, theme_member_ids: null,
    stability_days: null, tide_state: 'active', tide_state_changed_at: null, is_anchored: false,
    superseded_by: null,
  } as Observation;
}

function transportReturning(text: string): SummarizerTransport {
  return async () => ({ content: [{ type: 'text', text }], model: 'test-model' });
}

// ---------------------------------------------------------------------------
// Every failure path here used to `return []` — byte-identical to "none of these qualify".
// Survivable only while nothing recorded the answer; the moment a decline is STAMPED (v23),
// one truncated response would permanently retire 20 observations that were never judged.
// So the contract is: ok:true carries verdicts, ok:false means WE LEARNED NOTHING.
// ---------------------------------------------------------------------------

test('buildPromotionJudge — parses survivors from model JSON, distills fields', async () => {
  const judge = buildPromotionJudge(transportReturning(JSON.stringify({
    promote: [
      { sourceObservationId: 1, type: 'decision', name: 'Use bun:sqlite',
        description: 'Standardized on bun:sqlite', body: 'We chose bun:sqlite for ...' },
    ],
  })));
  const out = await judge([obs(1), obs(2)]);
  expect(out).toEqual({ ok: true, verdicts: [
    { sourceObservationId: 1, type: 'decision', name: 'Use bun:sqlite',
      description: 'Standardized on bun:sqlite', body: 'We chose bun:sqlite for ...' },
  ] });
});

test('buildPromotionJudge — empty candidate list never calls the model', async () => {
  let called = false;
  const judge = buildPromotionJudge(async () => { called = true; return { content: [{ type: 'text', text: '{}' }], model: 'm' }; });
  expect(await judge([])).toEqual({ ok: true, verdicts: [] });   // a REAL empty verdict
  expect(called).toBe(false);
});

test('buildPromotionJudge — malformed JSON is an ERROR, not "declined everything"', async () => {
  const out = await buildPromotionJudge(transportReturning('not json at all'))([obs(1)]);
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.error).toContain('truncated');   // the remedy names the actual cause
});

test('buildPromotionJudge — a TRUNCATED verdict array is an error, not an empty one', async () => {
  // The realistic shape: a valid prefix, cut mid-array because max_tokens ran out. This is what
  // 1500 tokens produced at ~3 survivors, and it used to read as "promote nothing".
  const truncated = '{"promote":[{"sourceObservationId":1,"type":"decision","name":"a","description":"b","body":"ccc';
  const out = await buildPromotionJudge(transportReturning(truncated))([obs(1)]);
  expect(out.ok).toBe(false);
});

test('buildPromotionJudge — schema mismatch is an error, not an empty verdict', async () => {
  const out = await buildPromotionJudge(transportReturning(JSON.stringify({ promote: [{ nope: 1 }] })))([obs(1)]);
  expect(out.ok).toBe(false);
});

test('buildPromotionJudge — model genuinely returns no survivors ⇒ ok with []', async () => {
  const judge = buildPromotionJudge(transportReturning(JSON.stringify({ promote: [] })));
  expect(await judge([obs(1)])).toEqual({ ok: true, verdicts: [] });
});

test('buildPromotionJudge — drops survivors referencing an id NOT in the candidate set', async () => {
  const judge = buildPromotionJudge(transportReturning(JSON.stringify({
    promote: [{ sourceObservationId: 99, type: 'decision', name: 'x', description: 'x', body: 'x' }],
  })));
  expect(await judge([obs(1)])).toEqual({ ok: true, verdicts: [] });  // hallucinated id, still a valid run
});

test('buildPromotionJudge — transport failure is an error, and says so', async () => {
  const out = await buildPromotionJudge(async () => { throw new Error('offline'); })([obs(1)]);
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.error).toContain('offline');
});

test('DEFAULT_JUDGE_MAX_TOKENS is large enough for a full batch of distilled bodies', () => {
  // 1500 was the shipped value and truncated at roughly three survivors — the exact input that
  // produced a silent empty verdict. Guard the direction, not a magic number.
  expect(DEFAULT_JUDGE_MAX_TOKENS).toBeGreaterThanOrEqual(8000);
});
