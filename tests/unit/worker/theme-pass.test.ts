import { test, expect, describe } from 'bun:test';
import { runThemePass } from '../../../src/worker/theme-pass.ts';
import type { ThemeCluster } from '../../../src/worker/theme-cluster.ts';

const cluster = (ids: number[]): ThemeCluster => ({
  members: ids.map(id => ({
    id, type: 'discovery', title: `t${id}`, session_id: `s${id}`,
    created_at_epoch: 1000 + id, from_auto: 1, from_search: 0, from_drill: 0,
  })),
  sessionCount: ids.length,
});
const draft = { title: 'a durable fact', narrative: '', facts: [], concepts: [] };
const base = {
  judge: async () => draft,
  createTheme: () => 1,
  shouldAbort: () => false,
  yieldToLoop: () => Promise.resolve(),
};

describe('runThemePass', () => {
  test('writes a theme for each accepted cluster, with its member ids', async () => {
    const written: number[][] = [];
    const r = await runThemePass({
      ...base,
      clusters: () => [cluster([1, 2, 3]), cluster([4, 5, 6])],
      createTheme: (_d, ids) => { written.push(ids); return written.length; },
    });
    expect(r.themesWritten).toBe(2);
    expect(r.declined).toBe(0);
    expect(written).toEqual([[1, 2, 3], [4, 5, 6]]);
  });

  // Declining is the judge doing its job, not an error. A declined cluster must be left
  // completely untouched so a later pass can reach a different answer.
  test('a declined cluster is counted and nothing is written', async () => {
    let writes = 0;
    const r = await runThemePass({
      ...base,
      clusters: () => [cluster([1, 2, 3])],
      judge: async () => null,
      createTheme: () => { writes++; return 1; },
    });
    expect(r.declined).toBe(1);
    expect(r.themesWritten).toBe(0);
    expect(writes).toBe(0);
  });

  test('stops before spending another model call once ingest arrives', async () => {
    let judged = 0;
    const r = await runThemePass({
      ...base,
      clusters: () => [cluster([1, 2]), cluster([3, 4]), cluster([5, 6])],
      judge: async () => { judged++; return draft; },
      shouldAbort: () => judged >= 1,
    });
    expect(r.aborted).toBe(true);
    expect(judged).toBe(1);
  });

  // One unwritable cluster must not take the pass down with it.
  test('a failed write is counted, not thrown', async () => {
    const r = await runThemePass({
      ...base,
      clusters: () => [cluster([1, 2]), cluster([3, 4])],
      createTheme: (_d, ids) => { if (ids[0] === 1) throw new Error('constraint'); return 7; },
    });
    expect(r.failed).toBe(1);
    expect(r.themesWritten).toBe(1);          // the second still went through
  });

  test('no clusters ⇒ no model calls at all', async () => {
    let judged = 0;
    const r = await runThemePass({
      ...base, clusters: () => [], judge: async () => { judged++; return draft; },
    });
    expect(r).toEqual({ clustersConsidered: 0, themesWritten: 0, declined: 0, failed: 0, aborted: false });
    expect(judged).toBe(0);
  });

  test('yields between clusters so the heartbeat keeps beating', async () => {
    let yields = 0;
    await runThemePass({
      ...base,
      clusters: () => [cluster([1, 2]), cluster([3, 4])],
      yieldToLoop: () => { yields++; return Promise.resolve(); },
    });
    expect(yields).toBe(2);
  });
});
