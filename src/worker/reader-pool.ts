// src/worker/reader-pool.ts — tracks reader engines + their in-flight load. Generic over the
// reader handle type so it can be unit-tested with plain strings. NOT thread-aware itself; the
// caller (threaded-main) maps a picked handle to its ThreadChannel. Selection is least-loaded
// under a per-reader concurrency cap; pick() returns null when every reader is at capacity (the
// caller then queues / briefly waits) or when the pool is empty (caller falls back to the writer).
export class ReaderPool<T> {
  private members: T[] = [];
  private inflight = new Map<T, number>();
  constructor(private maxInFlightPerReader = 1) {}

  add(r: T): void { if (!this.inflight.has(r)) { this.members.push(r); this.inflight.set(r, 0); } }
  remove(r: T): void { this.members = this.members.filter(m => m !== r); this.inflight.delete(r); }
  size(): number { return this.members.length; }
  acquire(r: T): void { this.inflight.set(r, (this.inflight.get(r) ?? 0) + 1); }
  release(r: T): void { const n = this.inflight.get(r); if (n !== undefined) this.inflight.set(r, Math.max(0, n - 1)); }

  /** Least-loaded ready reader under capacity, or null if all are saturated / the pool is empty. */
  pick(): T | null {
    let best: T | null = null; let bestN = Infinity;
    for (const r of this.members) {
      const n = this.inflight.get(r) ?? 0;
      if (n < this.maxInFlightPerReader && n < bestN) { best = r; bestN = n; }
    }
    return best;
  }
}
