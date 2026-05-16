/**
 * In-process counters for worker efficiency stats. Reset on every worker
 * restart — the figures are deliberately "since worker start", not lifetime
 * (lifetime recall savings is a separate sub-project). Plain mutable struct;
 * the worker owns one instance and the /stats handler reads it.
 */
export interface WorkerMetrics {
  embedCalls: number;            // number of embedder.embed() calls during indexing
  embedTokens: number;           // total tokens submitted across those calls
  embedMs: number;               // total wall-clock ms spent in those calls
  docsSeen: number;              // file-based documents the indexer considered
  docsSkippedUnchanged: number;  // of those, how many were skipped (sha unchanged)
}

export function createWorkerMetrics(): WorkerMetrics {
  return { embedCalls: 0, embedTokens: 0, embedMs: 0, docsSeen: 0, docsSkippedUnchanged: 0 };
}

export function recordEmbed(m: WorkerMetrics, tokens: number, ms: number): void {
  m.embedCalls += 1;
  m.embedTokens += tokens;
  m.embedMs += ms;
}

export function recordIndexResult(m: WorkerMetrics, result: 'indexed' | 'skipped'): void {
  m.docsSeen += 1;
  if (result === 'skipped') m.docsSkippedUnchanged += 1;
}
