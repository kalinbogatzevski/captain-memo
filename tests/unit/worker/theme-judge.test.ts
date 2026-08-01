import { test, expect, describe } from 'bun:test';
import { buildThemeJudge } from '../../../src/worker/theme-judge.ts';
import type { ThemeCluster } from '../../../src/worker/theme-cluster.ts';

// This is the one component in the whole consolidation path that GENERATES text, so a bad reply
// is a failure mode `--undo` cannot fully repair: restoring the members is easy, un-reading a
// wrong summary is not. Every ambiguous outcome therefore resolves to "write no theme". The
// members stay exactly as they are and the next pass tries again.

const cluster = (ids: number[]): ThemeCluster => ({
  members: ids.map(id => ({
    id, type: 'discovery', title: `title ${id}`, session_id: `s${id}`,
    created_at_epoch: 1000 + id, from_auto: 1, from_search: 0, from_drill: 0,
  })),
  sessionCount: ids.length,
});
const reply = (obj: unknown) => async () => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj) }] });
const good = {
  theme: {
    title: 'update-status skill is available and callable',
    narrative: 'Confirmed across three sessions.',
    facts: ['registered in erp-platform'],
    concepts: ['skills'],
  },
};

describe('buildThemeJudge', () => {
  test('returns the theme the model wrote', async () => {
    const j = buildThemeJudge(reply(good) as never);
    const r = await j(cluster([1, 2, 3]));
    expect(r?.title).toBe('update-status skill is available and callable');
    expect(r?.facts).toEqual(['registered in erp-platform']);
  });

  test('never calls the model on an empty cluster', async () => {
    let called = false;
    const j = buildThemeJudge((async () => { called = true; return { content: [] }; }) as never);
    expect(await j({ members: [], sessionCount: 0 })).toBeNull();
    expect(called).toBe(false);
  });

  // A transport failure must not stall the pass or, worse, produce a placeholder theme.
  test('transport throw ⇒ no theme', async () => {
    const j = buildThemeJudge((async () => { throw new Error('offline'); }) as never);
    expect(await j(cluster([1, 2, 3]))).toBeNull();
  });

  test('unparseable reply ⇒ no theme', async () => {
    const j = buildThemeJudge((async () => ({ content: [{ type: 'text' as const, text: 'sorry, I cannot' }] })) as never);
    expect(await j(cluster([1, 2, 3]))).toBeNull();
  });

  test('schema mismatch ⇒ no theme', async () => {
    const j = buildThemeJudge(reply({ theme: { narrative: 'no title field' } }) as never);
    expect(await j(cluster([1, 2, 3]))).toBeNull();
  });

  test('empty content ⇒ no theme', async () => {
    const j = buildThemeJudge((async () => ({ content: [] })) as never);
    expect(await j(cluster([1, 2, 3]))).toBeNull();
  });

  // The model declining is a legitimate answer, not an error: a cluster the finder gathered by
  // cosine may still be several distinct facts that happen to use similar words.
  test('an explicit decline is respected', async () => {
    const j = buildThemeJudge(reply({ theme: null }) as never);
    expect(await j(cluster([1, 2, 3]))).toBeNull();
  });

  test('a blank title is not a theme', async () => {
    const j = buildThemeJudge(reply({ theme: { ...good.theme, title: '   ' } }) as never);
    expect(await j(cluster([1, 2, 3]))).toBeNull();
  });

  // JSON wrapped in prose or a code fence is the common real-world reply shape.
  test('extracts JSON embedded in prose', async () => {
    const j = buildThemeJudge((async () => ({
      content: [{ type: 'text' as const, text: 'Here you go:\n```json\n' + JSON.stringify(good) + '\n```' }],
    })) as never);
    expect((await j(cluster([1, 2, 3])))?.title).toBe(good.theme.title);
  });

  test('every member title reaches the prompt', async () => {
    let seen = '';
    const j = buildThemeJudge((async (req: { user: string }) => {
      seen = req.user; return { content: [{ type: 'text' as const, text: JSON.stringify(good) }] };
    }) as never);
    await j(cluster([1, 2, 3]));
    for (const id of [1, 2, 3]) expect(seen).toContain(`title ${id}`);
  });
});
