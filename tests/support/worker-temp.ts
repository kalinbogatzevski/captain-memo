import { rmSync } from 'fs';

/**
 * Best-effort delete of a worker's temp work-dir in test teardown.
 *
 * On Windows the worker's SQLite/WAL files can stay locked past `worker.stop()`
 * (the OS doesn't release the handle as promptly as Linux, which unlinks open
 * files freely), so a recursive delete may throw EBUSY/EPERM. Every assertion
 * has already run by teardown and the dir lives under the OS tmpdir, so a failed
 * delete must NEVER fail the test — and crucially must never throw, because a
 * throw here would skip any `process.env` reset after it and leak CAPTAIN_MEMO_*
 * flags into the next test. Retry briefly, then warn and move on.
 *
 * USAGE: clear process.env BEFORE calling this (defence in depth), then:
 *   afterEach(async () => {
 *     if (worker) { await worker.stop(); worker = null; }
 *     for (const k of ENV_KEYS) delete process.env[k];   // reset first — never skipped
 *     rmWorkDir(workDir); workDir = '';
 *   });
 */
export function rmWorkDir(dir: string): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
  } catch (e) {
    console.warn(`[test] temp cleanup skipped: ${(e as Error).message}`);
  }
}
