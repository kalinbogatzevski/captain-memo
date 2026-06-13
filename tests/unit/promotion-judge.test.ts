import { test, expect } from 'bun:test';
import { buildPromotionJudge } from '../../src/worker/promotion-judge.ts';
import type { SummarizerTransport } from '../../src/worker/summarizer.ts';
import type { Observation } from '../../src/shared/types.ts';

function obs(id: number): Observation {
  return {
    id, session_id: 's', project_id: 'default', prompt_number: 1,
    type: 'decision', title: `title ${id}`, narrative: `narrative ${id}`,
    facts: [`fact ${id}`], concepts: ['c'], files_read: [], files_modified: [],
    created_at_epoch: 1_700_000_000, branch: null, work_tokens: null, stored_tokens: null,
    retrieval_count: 0, last_retrieved_at: null,
    from_auto: 0, from_search: 1, from_drill: 0,
    last_surfaced_at: null, last_surfaced_source: null,
    archived: false, archived_into_theme_id: null, theme_member_ids: null,
    stability_days: null, tide_state: 'active', tide_state_changed_at: null, is_anchored: false,
  } as Observation;
}

function transportReturning(text: string): SummarizerTransport {
  return async () => ({ content: [{ type: 'text', text }], model: 'test-model' });
}

test('buildPromotionJudge — parses survivors from model JSON, distills fields', async () => {
  const judge = buildPromotionJudge(transportReturning(JSON.stringify({
    promote: [
      { sourceObservationId: 1, type: 'decision', name: 'Use bun:sqlite',
        description: 'Standardized on bun:sqlite', body: 'We chose bun:sqlite for ...' },
    ],
  })));
  const out = await judge([obs(1), obs(2)]);
  expect(out).toEqual([
    { sourceObservationId: 1, type: 'decision', name: 'Use bun:sqlite',
      description: 'Standardized on bun:sqlite', body: 'We chose bun:sqlite for ...' },
  ]);
});

test('buildPromotionJudge — empty candidate list never calls the model, returns []', async () => {
  let called = false;
  const judge = buildPromotionJudge(async () => { called = true; return { content: [{ type: 'text', text: '{}' }], model: 'm' }; });
  expect(await judge([])).toEqual([]);
  expect(called).toBe(false);
});

test('buildPromotionJudge — malformed JSON ⇒ zero survivors (promotes nothing)', async () => {
  const judge = buildPromotionJudge(transportReturning('not json at all'));
  expect(await judge([obs(1)])).toEqual([]);
});

test('buildPromotionJudge — model returns no survivors ⇒ []', async () => {
  const judge = buildPromotionJudge(transportReturning(JSON.stringify({ promote: [] })));
  expect(await judge([obs(1)])).toEqual([]);
});

test('buildPromotionJudge — drops survivors referencing an id NOT in the candidate set', async () => {
  const judge = buildPromotionJudge(transportReturning(JSON.stringify({
    promote: [{ sourceObservationId: 99, type: 'decision', name: 'x', description: 'x', body: 'x' }],
  })));
  expect(await judge([obs(1)])).toEqual([]);
});

test('buildPromotionJudge — transport throws ⇒ [] (never blocks the run)', async () => {
  const judge = buildPromotionJudge(async () => { throw new Error('offline'); });
  expect(await judge([obs(1)])).toEqual([]);
});
