// The worker's boot-time embedder dimension probe, retried in the background. It catches the dim-mismatch trap (index
// N-dim, embedder M-dim) before any chunk reaches vector.add(). One boot attempt left /stats and `doctor` blind for the
// worker's whole life whenever the embedder came up after it (Ollama in docker starting after the worker, 2026-10-02).
// Cost: one 1-token embed call per retry, at most RETRY_MS.length retries over about an hour, then it says so and stops.
export const RETRY_MS = [5_000, 15_000, 45_000, 120_000, 300_000, 300_000, 300_000, 300_000, 300_000, 300_000, 300_000, 300_000];

export interface EmbedderProbeDeps {
  embed: (texts: string[]) => Promise<number[][]>;
  indexDim: number;
  onDim: (dim: number | null) => void;
  log: (msg: string) => void;
  error: (msg: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;   // injected by tests
  clearTimer?: (handle: unknown) => void;
}

const mismatch = (actual: number, index: number): string =>
  `[worker] DIM MISMATCH: the vector index is ${index}-dim but the embedder returns ${actual}-dim. ` +
  `Every write (remember) will fail and vector search silently falls back to keyword-only. ` +
  `Fix: run \`captain-memo reindex --redim ${actual}\` — it rebuilds the index at the embedder's dimension ` +
  `(re-embedding from observations.db). Setting CAPTAIN_MEMO_EMBEDDING_DIM alone will NOT fix an existing index. ` +
  `Alternatively, switch back to a model that returns ${index}-dim.`;

/** Probes once (awaited, so boot sees the first answer), then keeps retrying in the background until the embedder answers. */
export async function startEmbedderProbe(d: EmbedderProbeDeps): Promise<{ stop: () => void }> {
  const setT = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown = null, stopped = false, retries = 0;

  const once = async (): Promise<boolean> => {
    try {
      const probe = await d.embed(['probe']);
      const actual = probe[0]?.length ?? 0;
      d.onDim(actual || null);
      if (actual !== d.indexDim) d.error(mismatch(actual, d.indexDim));
      else d.log(`[worker] embedder probe OK (dim=${actual})${retries ? ` after ${retries} ${retries === 1 ? 'retry' : 'retries'}` : ''}`);
      return true;
    } catch (err) {
      // Not fatal: keyword search still works, and the vector half logs per-call errors (search.ts).
      if (retries === 0) d.error(`[worker] embedder probe failed at boot: ${(err as Error).message}`);
      return false;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    if (retries >= RETRY_MS.length) {
      d.error(`[worker] embedder probe: still unreachable after ${retries} retries; /stats and doctor cannot verify the embedder dim until the worker restarts`);
      return;
    }
    timer = setT(() => {
      timer = null;
      if (stopped) return;
      retries++;
      void once().then((ok) => { if (!ok) schedule(); });
    }, RETRY_MS[retries]!);
    (timer as { unref?: () => void } | null)?.unref?.();
  };

  if (!(await once())) schedule();
  return { stop: () => { stopped = true; if (timer !== null) clearT(timer); timer = null; } };
}
