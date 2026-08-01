import { test, expect, describe } from 'bun:test';
import { runThemePass } from '../../../src/worker/theme-pass.ts';
import type { ThemeCluster } from '../../../src/worker/theme-cluster.ts';

const cluster = (ids: number[]): ThemeCluster => ({
  members: ids.map(id => ({
    id, type: 'discovery', title: `t${id}`, session_id: `s${id}`,
    created_at_epoch: 1000 + id, project_id: 'p', branch: null,
    from_auto: 1, from_search: 0, from_drill: 0,
  })),
  sessionCount: ids.length, project_id: 'p', branch: null,
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

  // FOUND BY ADVERSARIAL REVIEW. createTheme is a raw INSERT — it writes no chunks, no vectors
  // and no meta document — while archiving its members, which ARE dropped from every search and
  // auto-inject surface. Without indexing the theme, the pass removed N observations from
  // retrieval and put nothing reachable in their place. The writer is therefore async, and its
  // failure must count as failed rather than reporting a theme nobody can find.
  test('awaits the writer, so an indexing failure is not reported as a success', async () => {
    const r = await runThemePass({
      ...base,
      clusters: () => [cluster([1, 2, 3])],
      createTheme: async () => { throw new Error('embedder offline'); },
    });
    expect(r.themesWritten).toBe(0);
    expect(r.failed).toBe(1);
  });

  test('hands the writer the cluster scope, never a worker-wide default', async () => {
    const seen: Array<{ project_id: string; branch: string | null }> = [];
    const c = cluster([1, 2, 3]);
    c.project_id = 'erp-platform'; c.branch = 'master';
    await runThemePass({
      ...base, clusters: () => [c],
      createTheme: (_d, _ids, scope) => { seen.push(scope); return 1; },
    });
    expect(seen).toEqual([{ project_id: 'erp-platform', branch: 'master' }]);
  });

  // A scheduled run steps aside for ingest — it comes round again shortly and has nothing to
  // prove. A FORCED run was explicitly asked for, and on a working machine the queue is almost
  // never empty, so abandoning the whole tick made `--for` report zeros it never earned.
  test('a scheduled run still abandons its tick to ingest', async () => {
    const r = await runThemePass({
      ...base, clusters: () => [cluster([1, 2, 3])], shouldAbort: () => true,
    });
    expect(r.aborted).toBe(true);
    expect(r.clustersConsidered).toBe(0);
  });

  test('a forced run waits for the coast to clear and then works', async () => {
    let busy = true;
    const r = await runThemePass({
      ...base,
      clusters: () => [cluster([1, 2, 3])],
      shouldAbort: () => busy,
      waitForQuiet: async () => { busy = false; return true; },
    });
    expect(r.aborted).toBe(false);
    expect(r.clustersConsidered).toBe(1);
    expect(r.themesWritten).toBe(1);
  });

  test('a forced run that waits in vain still reports the abort honestly', async () => {
    const r = await runThemePass({
      ...base,
      clusters: () => [cluster([1, 2, 3])],
      shouldAbort: () => true,
      waitForQuiet: async () => false,          // never cleared
    });
    expect(r.aborted).toBe(true);
    expect(r.clustersConsidered).toBe(0);
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
