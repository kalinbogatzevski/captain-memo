// src/shared/paged-read.ts — read a whole table without holding the engine's event loop.
//
// The hourly passes used to load their population in one .all(): 201k observation rows (2.4 s), the
// version rows (2.0 s), the vector-cluster map (7.9 s) and a chunk→observation lookup per chunk (31.6 s),
// all synchronous on the WRITER. Every request queued behind them — a 70 s freeze measured 2026-09-29,
// with writer-routed calls timing out about every ten minutes. Keyset pages of
// PAGE_ROWS with a yield between them keep each blocking step to a few ms; the total work is unchanged.

/** Rows per page: 1 000 fat observation rows blocked 40-50 ms on the 316 MB reference corpus, 250 about a quarter of that. */
export const PAGE_ROWS = 250;

/**
 * Every row `page` returns, one keyset page at a time. `page(after, limit)` must return rows with
 * key > `after`, ordered by key ascending, at most `limit` of them; `key` reads that key back.
 * Keys are integer rowids, so a start of 0 sees every row.
 */
export async function readPaged<T>(
  page: (after: number, limit: number) => T[],
  key: (row: T) => number,
  yieldToLoop: () => Promise<void> = () => Promise.resolve(),
): Promise<T[]> {
  const out: T[] = [];
  let after = 0;
  for (;;) {
    const rows = page(after, PAGE_ROWS);
    for (const r of rows) out.push(r);
    if (rows.length < PAGE_ROWS) return out;
    after = key(rows[rows.length - 1]!);
    await yieldToLoop();
  }
}
