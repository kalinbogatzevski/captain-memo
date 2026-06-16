// src/cli/commands/restart.ts — `captain-memo restart [--force]`.
// Restarts the local worker so it reloads config / recovers. Platform-agnostic:
// restartWorker dispatches per-OS inside getServiceManager().restart() (systemd
// restart on Linux; Stop+Start the Scheduled Task on Windows). Default is a
// graceful drain (POST /shutdown first); --force hard-stops a wedged worker.
import { DEFAULT_WORKER_PORT } from '../../shared/paths.ts';
import { getServiceManager } from '../../services/service-manager/index.ts';
import { restartWorker } from '../../shared/worker-control.ts';
import { probeHealthOnce } from '../../shared/worker-health-probe.ts';
import type { ServiceManager } from '../../services/service-manager/types.ts';

const WORKER_SERVICE = 'captain-memo-worker';

export interface RestartDeps {
  sm?: ServiceManager;
  port?: number;
  probe?: (port: number, timeoutMs?: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function restartCommand(args: string[] = [], deps: RestartDeps = {}): Promise<number> {
  const force = args.includes('--force');
  const graceful = !force;
  const port = deps.port ?? Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
  const sm = deps.sm ?? getServiceManager();
  const probe = deps.probe ?? probeHealthOnce;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  console.log(`Restarting captain-memo worker${force ? ' (forced)' : ''}…`);
  await restartWorker(sm, WORKER_SERVICE, { port, graceful });

  const deadline = now() + 8000;
  while (now() < deadline) {
    if (await probe(port, 1500)) {
      console.log('✓ worker is healthy');
      return 0;
    }
    await sleep(500);
  }
  console.error('worker restarted but did not report healthy within 8s — check `captain-memo status`');
  return 1;
}
