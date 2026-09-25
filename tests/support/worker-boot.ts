// Waiting for a spawned worker process to answer /health, shared by the tests that boot a real one.
//
// BOOT_WAIT_MS, from windows-latest (CI run 36154197883): a healthy boot answers in ~1.1 s. On attempt 1 three
// worker boots stalled inside one window (15:29:52 to 15:31:12): two spawned workers were still not healthy at
// the 25 s cap, and an in-process startWorker logged its "capture armed" line (index.ts, well before Bun.serve)
// only 29.5 s in, then hit the 30 s test timeout. So 29.5 s is a lower bound, not a boot time. A boot one second
// after that window took 1.4 s, and the rerun passed. The cause is unknown: the spawned workers' stderr was
// discarded, which is why it is now piped (tailOf). 90 s is ~3x that lower bound. Linux keeps 25 s, so a real
// hang still fails fast there, and on Windows a worker that EXITS fails at once (below) instead of waiting out
// the budget. A boot that passes but is slow warns (here, and in startWorker), so a green run keeps the trace.
export const BOOT_WAIT_MS = process.platform === 'win32' ? 90_000 : 25_000;

/** What the Windows boot budget adds over Linux's (0 on Linux). A test that boots a worker in its OWN body and
 *  sets its own timeout adds this to it: bun lets an explicit per-test timeout override the CLI --timeout, so
 *  CI's Windows 90 s never reaches that test. Hooks and tests without their own timeout do inherit it. */
export const BOOT_SLACK_MS = BOOT_WAIT_MS - 25_000;

/** A boot slower than this still passes, but says so, so a green run keeps the trace of a stall. */
const SLOW_BOOT_MS = 10_000;

/** The last `max` chars of a piped stream, drained continuously. An undrained pipe fills up and blocks the
 *  worker's writes, so a test that piped stderr without draining it would cause the hang it reports. */
export function tailOf(stream: ReadableStream<Uint8Array>, max = 4000): () => string {
  let buf = '';
  const dec = new TextDecoder();
  void (async () => {
    try { for await (const chunk of stream) buf = (buf + dec.decode(chunk, { stream: true })).slice(-max); } catch { /* process gone */ }
  })();
  return () => buf;
}

/** Resolve once `${base}/health` answers ok. Reject at once if the process exits first, and after BOOT_WAIT_MS if
 *  it never answers; both errors carry the worker's stderr tail, so the next flake names the phase it stuck in. */
export async function waitHealthy(base: string, proc: { exited: Promise<number> }, tail: () => string = () => '', ms = BOOT_WAIT_MS): Promise<void> {
  let code: number | undefined;
  void proc.exited.then((c) => { code = c; });
  const t0 = Date.now();
  const end = t0 + ms;
  while (Date.now() < end) {
    if (code !== undefined) {
      await Bun.sleep(100);   // ponytail: a grace for the drain to read the last lines, not a sync on it
      throw new Error(`worker exited with code ${code} before /health answered. stderr tail:\n${tail()}`);
    }
    // Bounded, so a worker that accepts but never answers still reaches the stderr-tail error below.
    try {
      if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })).ok) {
        const took = Date.now() - t0;
        if (took > SLOW_BOOT_MS) console.warn(`[worker-boot] slow boot: ${base} healthy after ${took} ms. stderr tail:\n${tail()}`);
        return;
      }
    } catch { /* not answering yet */ }
    await Bun.sleep(150);
  }
  throw new Error(`never healthy within ${ms} ms. stderr tail:\n${tail()}`);
}
