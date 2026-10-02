// #276: a boot probe that fails once (embedder not up yet) is retried in the background until the embedder answers.
import { test, expect } from 'bun:test';
import { startEmbedderProbe, RETRY_MS } from '../../src/worker/embedder-probe.ts';

function harness(embeds: Array<number | Error>, indexDim = 768) {
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const logs: string[] = [], errors: string[] = [], dims: Array<number | null> = [];
  let n = 0;
  const deps = {
    embed: async () => { const r = embeds[Math.min(n++, embeds.length - 1)]!; if (r instanceof Error) throw r; return [new Array(r).fill(0)]; },
    indexDim, onDim: (d: number | null) => dims.push(d), log: (m: string) => logs.push(m), error: (m: string) => errors.push(m),
    setTimer: (fn: () => void, ms: number) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t; },
    clearTimer: (h: unknown) => { (h as { cancelled: boolean }).cancelled = true; },
  };
  const fire = async () => { const t = timers.shift()!; if (!t.cancelled) t.fn(); await new Promise((r) => setTimeout(r, 0)); };
  return { deps, timers, logs, errors, dims, fire, calls: () => n };
}

test('an embedder that answers at boot: dim recorded, no retry scheduled', async () => {
  const h = harness([768]);
  await startEmbedderProbe(h.deps);
  expect(h.dims).toEqual([768]); expect(h.logs[0]).toBe('[worker] embedder probe OK (dim=768)'); expect(h.timers).toHaveLength(0);
});

test('an embedder that is not up at boot: one failure logged, retries back off, dim filled when it answers', async () => {
  const h = harness([new Error('Unable to connect'), new Error('aborted'), 768]);
  await startEmbedderProbe(h.deps);
  expect(h.errors).toEqual(['[worker] embedder probe failed at boot: Unable to connect']);
  expect(h.dims).toEqual([]); expect(h.timers.map((t) => t.ms)).toEqual([RETRY_MS[0]!]);
  await h.fire();                                                  // retry 1 fails quietly, the next one is scheduled
  expect(h.errors).toHaveLength(1); expect(h.timers.map((t) => t.ms)).toEqual([RETRY_MS[1]!]);
  await h.fire();                                                  // retry 2 answers
  expect(h.dims).toEqual([768]); expect(h.logs.at(-1)).toBe('[worker] embedder probe OK (dim=768) after 2 retries'); expect(h.timers).toHaveLength(0);
});

test('a dim mismatch is reported with the same fix text and is not retried', async () => {
  const h = harness([1024], 768);
  await startEmbedderProbe(h.deps);
  expect(h.dims).toEqual([1024]); expect(h.errors[0]).toContain('DIM MISMATCH: the vector index is 768-dim but the embedder returns 1024-dim');
  expect(h.errors[0]).toContain('captain-memo reindex --redim 1024'); expect(h.timers).toHaveLength(0);
});

test('stop() cancels the pending retry, and a callback that still fires does nothing', async () => {
  const h = harness([new Error('down')]);
  const p = await startEmbedderProbe(h.deps);
  const t = h.timers[0]!;
  p.stop();
  expect(t.cancelled).toBe(true);
  const before = h.calls(); t.fn(); await new Promise((r) => setTimeout(r, 0));
  expect(h.calls()).toBe(before);
});

test('it gives up after RETRY_MS.length retries, says so once, and stops calling the embedder', async () => {
  const h = harness([new Error('down')]);
  await startEmbedderProbe(h.deps);
  for (let i = 0; i < RETRY_MS.length; i++) await h.fire();
  expect(h.timers).toHaveLength(0);
  expect(h.errors).toHaveLength(2); expect(h.errors[1]).toContain(`still unreachable after ${RETRY_MS.length} retries`);
  expect(h.calls()).toBe(1 + RETRY_MS.length);
});
