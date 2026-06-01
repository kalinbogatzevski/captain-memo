// captain-memo worker-watchdog — the action the captain-memo-watchdog Scheduled
// Task runs every 5 min. Probes the worker's /health and, if it is unreachable
// (DEAD or ZOMBIE — process alive but HTTP server wedged), force-reclaims the port
// owner and restarts the worker. This is the only recovery path that survives a
// zombie while no Claude session is open (see src/shared/worker-watchdog.ts).
//
// Internal command (not advertised in the main help) — it exists to be a task
// action, not something users run by hand. Always exits 0: a watchdog that throws
// would just log a Task Scheduler "last result" error and retry next tick anyway.

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { DEFAULT_WORKER_PORT, LOGS_DIR } from '../../shared/paths.ts';
import { runWorkerWatchdog } from '../../shared/worker-watchdog.ts';
import { restartWorker } from '../../shared/worker-control.ts';
import { acquireHealLock, releaseHealLock } from '../../shared/worker-heal-lock.ts';
import { getServiceManager } from '../../services/service-manager/index.ts';

const WORKER = 'captain-memo-worker';

/** True iff the worker answers GET /health with {"healthy":true} within timeoutMs. */
async function probeHealthy(port: number, timeoutMs = 3000): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
    if (!r.ok) return false;
    const body = (await r.json().catch(() => null)) as { healthy?: boolean } | null;
    return body?.healthy === true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// Log only the INTERESTING outcomes (a recovery attempt or a failure). The
// healthy no-op fires every 5 minutes — logging it would flood worker.log.
function logWatchdog(line: string): void {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(join(LOGS_DIR, 'worker.log'), `[watchdog] ${line}\n`);
  } catch {
    // logging is best-effort — never let it break the watchdog
  }
}

export async function workerWatchdogCommand(_args: string[]): Promise<number> {
  const port = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
  const sm = getServiceManager();
  try {
    const outcome = await runWorkerWatchdog({
      probeHealthy: () => probeHealthy(port),
      acquireLock: () => acquireHealLock(),
      releaseLock: () => releaseHealLock(),
      // No graceful: a worker that failed /health won't answer /shutdown either.
      reclaim: () => restartWorker(sm, WORKER, { port }),
      waitHealthy: async () => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          if (await probeHealthy(port, 1500)) return true;
          await new Promise((res) => setTimeout(res, 500));
        }
        return false;
      },
    });
    if (outcome.action === 'reclaimed') {
      logWatchdog(`worker was unreachable - reclaimed + restarted (healthy=${outcome.healthy})`);
    } else if (outcome.action === 'failed') {
      logWatchdog(`worker was unreachable - reclaim FAILED: ${outcome.error}`);
    }
  } catch (e) {
    logWatchdog(`unexpected error: ${(e as Error).message}`);
  }
  return 0;
}
