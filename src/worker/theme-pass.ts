// src/worker/theme-pass.ts — Stage 2's slice: find cross-session clusters, ask the judge for a
// theme, write the ones it accepts. Pure orchestration over injected deps, like quartermaster.ts.
//
// Two properties govern the shape:
//
//   1. The judge may decline, and declining is expected. The finder gathers by cosine, which
//      groups things that SOUND alike; only a reader can tell whether they SAY one thing. A
//      declined cluster is left completely untouched — no partial write, no marker, nothing to
//      clean up — and a later pass may reach a different answer as the corpus changes.
//
//   2. Every model call costs money and latency, so the pass is bounded on BOTH axes: at most
//      maxClusters candidates, and it stops the moment ingest arrives. Unlike the fold slices,
//      an abort here can strand nothing: each cluster is judged and written in one step.
import type { ThemeCluster } from './theme-cluster.ts';
import type { ThemeDraft } from './theme-judge.ts';

export interface ThemePassDeps {
  /** Cross-session clusters, already guarded and protection-filtered. */
  clusters: () => ThemeCluster[];
  /** Haiku wrapper. Returns null to decline — never throws (see theme-judge.ts). */
  judge: (cluster: ThemeCluster) => Promise<ThemeDraft | null>;
  /** Insert the theme, archive its members beneath it, and INDEX it so it is retrievable.
   *  Async because indexing embeds. Receives the cluster's scope so the theme is filed where
   *  its members live rather than wherever the worker happens to be pointed. */
  createTheme: (
    draft: ThemeDraft, memberIds: number[],
    scope: { project_id: string; branch: string | null },
  ) => Promise<number> | number;
  /** Remember a refusal so the next pass spends its budget on a cluster nobody has ruled on.
   *  Without this the stable cluster ordering meant the same head was re-judged every tick. */
  recordDecline?: (memberIds: number[]) => void;
  /** True when ingest/embedding work arrived — stop before spending another model call. */
  shouldAbort: () => boolean;
  /** Wait for ingest to pass rather than abandoning the pass outright. Supplied when the run was
   *  explicitly FORCED: on a machine in active use the queue is rarely empty, so aborting on the
   *  first check meant a forced pass examined nothing at all and reported a zero it never earned.
   *  Returns true if the coast cleared, false if it gave up. */
  waitForQuiet?: () => Promise<boolean>;
  yieldToLoop: () => Promise<void>;
}

export interface ThemePassResult {
  clustersConsidered: number;
  themesWritten: number;
  /** Clusters the judge looked at and refused. High is healthy, not a fault. */
  declined: number;
  /** Clusters whose write threw — counted, never rethrown, so one bad row cannot kill the pass. */
  failed: number;
  aborted: boolean;
}

/** Run one theme-building pass. Never throws. */
export async function runThemePass(deps: ThemePassDeps): Promise<ThemePassResult> {
  const res: ThemePassResult = {
    clustersConsidered: 0, themesWritten: 0, declined: 0, failed: 0, aborted: false,
  };
  for (const cluster of deps.clusters()) {
    if (deps.shouldAbort()) {
      // Forced runs wait it out; scheduled runs step aside — they will come round again shortly
      // and have nothing to prove.
      const cleared = deps.waitForQuiet ? await deps.waitForQuiet() : false;
      if (!cleared) { res.aborted = true; return res; }
    }
    res.clustersConsidered++;
    const draft = await deps.judge(cluster);
    if (!draft) {
      res.declined++;
      deps.recordDecline?.(cluster.members.map(m => m.id));
      await deps.yieldToLoop();
      continue;
    }
    try {
      await deps.createTheme(draft, cluster.members.map(m => m.id),
        { project_id: cluster.project_id, branch: cluster.branch });
      res.themesWritten++;
    } catch {
      // A failed write leaves the cluster exactly as it was (createTheme is transactional), so
      // the honest tally is "considered but not written" — never a silent success.
      res.failed++;
    }
    await deps.yieldToLoop();
  }
  return res;
}
