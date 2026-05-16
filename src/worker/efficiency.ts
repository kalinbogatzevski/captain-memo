import type { WorkerMetrics } from './metrics.ts';

export interface EfficiencyInput {
  workSum: number;          // SUM(work_tokens)   over paired observations
  storedSum: number;        // SUM(stored_tokens) over the SAME observations
  pairedCount: number;      // observations carrying BOTH values
  totalObservations: number;
  metrics: WorkerMetrics;
}

export interface EfficiencyReport {
  corpus: {
    work_tokens: number;
    stored_tokens: number;
    ratio: number | null;        // work / stored, 1 decimal; null when undefined
    saved_pct: number | null;    // 100*(work-stored)/work, clamped [0,100]; null when undefined
    coverage: { with_data: number; total: number };
  };
  embedder: { calls: number; avg_latency_ms: number; tokens_per_s: number };
  dedup: { docs_seen: number; skipped_unchanged: number; skip_pct: number };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function computeEfficiency(input: EfficiencyInput): EfficiencyReport {
  const { workSum, storedSum, pairedCount, totalObservations, metrics } = input;

  // Compression is only meaningful when work and stored are summed over the
  // same observations. pairedCount is the count of rows with BOTH values.
  const hasCorpus = pairedCount > 0 && workSum > 0 && storedSum > 0;
  const ratio = hasCorpus ? round1(workSum / storedSum) : null;
  const saved_pct = hasCorpus
    ? Math.max(0, Math.min(100, Math.round(((workSum - storedSum) / workSum) * 100)))
    : null;

  const avg_latency_ms = metrics.embedCalls > 0
    ? Math.round(metrics.embedMs / metrics.embedCalls)
    : 0;
  const tokens_per_s = metrics.embedMs > 0
    ? Math.round(metrics.embedTokens / (metrics.embedMs / 1000))
    : 0;
  const skip_pct = metrics.docsSeen > 0
    ? Math.round((metrics.docsSkippedUnchanged / metrics.docsSeen) * 100)
    : 0;

  return {
    corpus: {
      work_tokens: workSum,
      stored_tokens: storedSum,
      ratio,
      saved_pct,
      coverage: { with_data: pairedCount, total: totalObservations },
    },
    embedder: { calls: metrics.embedCalls, avg_latency_ms, tokens_per_s },
    dedup: {
      docs_seen: metrics.docsSeen,
      skipped_unchanged: metrics.docsSkippedUnchanged,
      skip_pct,
    },
  };
}
