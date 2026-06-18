// src/eval/run.ts — replay golden set per profile, score, format. Worker call +
// judge are injected for testability.
import type { GoldenEntry } from './golden.ts';
import type { JudgeFn } from './judge.ts';
import { freshestDoc, staleEntityDocs } from './oracle.ts';
import { mrr, ndcgAtK, recallAtK, freshnessAt1, stalenessRate } from './metrics.ts';

export interface EvalDoc { doc_id: string; created_at_epoch: number; text: string }

export interface ProfileReport {
  profile: string;
  mrr: number; ndcg5: number; ndcg10: number; recall10: number;
  freshnessAt1: number; stalenessRate: number;
  n: number; nTemporal: number;
}

export interface RunEvalDeps {
  golden: GoldenEntry[];
  profiles: string[];
  search: (query: string, profile: string, topK: number) => Promise<EvalDoc[]>;
  judge?: JudgeFn;
}

function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

export async function runEval(deps: RunEvalDeps): Promise<ProfileReport[]> {
  const reports: ProfileReport[] = [];
  for (const profile of deps.profiles) {
    const fresh: number[] = [], stale: number[] = [];
    const mrrs: number[] = [], n5: number[] = [], n10: number[] = [], r10: number[] = [];
    let nTemporal = 0;
    for (const g of deps.golden) {
      const hits = await deps.search(g.query, profile, 10);
      const ids = hits.map(h => h.doc_id);
      if (g.class === 'temporal' && g.entity) {
        nTemporal++;
        const best = freshestDoc(hits, g.entity);
        // No entity-matching doc returned at all = a total miss → freshness@1 = 0
        // (and no stale docs present → 0). Counted, so misses can't hide as "no data".
        fresh.push(best ? freshnessAt1(ids[0], best.doc_id) : 0);
        stale.push(best ? stalenessRate(ids, staleEntityDocs(hits, g.entity), 10) : 0);
      } else if (deps.judge) {
        const grades = new Map<string, number>();
        for (const h of hits) grades.set(h.doc_id, await deps.judge(g.query, h.text));
        const relevant = new Set([...grades.entries()].filter(([, v]) => v >= 2).map(([id]) => id));
        mrrs.push(mrr(ids, relevant));
        n5.push(ndcgAtK(ids, grades, 5));
        n10.push(ndcgAtK(ids, grades, 10));
        r10.push(recallAtK(ids, relevant, 10));
      }
    }
    reports.push({
      profile,
      mrr: mean(mrrs), ndcg5: mean(n5), ndcg10: mean(n10), recall10: mean(r10),
      freshnessAt1: mean(fresh), stalenessRate: mean(stale),
      n: deps.golden.length, nTemporal,
    });
  }
  return reports;
}

export function formatReportTable(reports: ProfileReport[]): string {
  const head = 'profile   mrr    ndcg@5 ndcg@10 recall@10 fresh@1 stale%  n  (temporal)';
  const rows = reports.map(r =>
    `${r.profile.padEnd(9)} ${r.mrr.toFixed(3)}  ${r.ndcg5.toFixed(3)}  ${r.ndcg10.toFixed(3)}   ` +
    `${r.recall10.toFixed(3)}     ${r.freshnessAt1.toFixed(3)}   ${r.stalenessRate.toFixed(3)}  ${r.n} (${r.nTemporal})`,
  );
  return [head, ...rows].join('\n');
}
