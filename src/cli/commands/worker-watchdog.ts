// captain-memo worker-watchdog — probe the worker's /health and, if it is
// unreachable (DEAD or ZOMBIE — process alive but HTTP server wedged), force-reclaim
// the port owner and restart the worker (see src/shared/worker-watchdog.ts).
//
// As of 0.2.17 this is a MANUAL command, not an autostarted task. The standalone
// captain-memo-watchdog Scheduled Task was removed because the Task Scheduler
// launches bun with an interactive token and flashed a console window every 5 min,
// with no clean no-admin way to hide it. Autonomous recovery now rides on the
// SessionStart/UserPromptSubmit self-heal (reclaim-then-start at session
// boundaries); run this by hand for an explicit kick. Always exits 0; not in help.

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { DEFAULT_WORKER_PORT, LOGS_DIR } from '../../shared/paths.ts';
import { runWorkerWatchdog } from '../../shared/worker-watchdog.ts';
import { restartWorker } from '../../shared/worker-control.ts';
import { acquireHealLock, releaseHealLock } from '../../shared/worker-heal-lock.ts';
import { getServiceManager } from '../../services/service-manager/index.ts';
import { probeHealthOnce, probeHealthyWithRetries } from '../../shared/worker-health-probe.ts';

const WORKER = 'captain-memo-worker';

// probeHealthOnce + probeHealthyWithRetries now live in ../../shared/worker-health-probe.ts
// (shared with the UserPromptSubmit hook's confirm-before-reclaim).

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
      // Confirm a real outage (3 spaced probes) before the destructive reclaim, so
      // a momentarily-busy worker is never killed — only a persistent zombie is.
      probeHealthy: () => probeHealthyWithRetries(() => probeHealthOnce(port)),
      acquireLock: () => acquireHealLock(),
      releaseLock: () => releaseHealLock(),
      // No graceful: a worker that failed /health won't answer /shutdown either.
      reclaim: () => restartWorker(sm, WORKER, { port }),
      waitHealthy: async () => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          if (await probeHealthOnce(port, 1500)) return true;
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
