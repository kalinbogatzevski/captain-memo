// src/cli/commands/restart.ts — `captain-memo restart [--force]`.
// Restarts the local worker so it reloads config / recovers. Platform-agnostic:
// restartWorker dispatches per-OS inside getServiceManager().restart() (systemd
// restart on Linux; Stop+Start the Scheduled Task on Windows). Default is a
// graceful drain (POST /shutdown first); --force hard-stops a wedged worker.
import { DEFAULT_WORKER_PORT } from '../../shared/paths.ts';
import { getServiceManager } from '../../services/service-manager/index.ts';
import { restartWorker } from '../../shared/worker-control.ts';
import { probeHealthOnce, readWorkerInstance } from '../../shared/worker-health-probe.ts';
import type { ServiceManager } from '../../services/service-manager/types.ts';

const WORKER_SERVICE = 'captain-memo-worker';

export interface RestartDeps {
  sm?: ServiceManager;
  port?: number;
  probe?: (port: number, timeoutMs?: number) => Promise<boolean>;
  /** Identify WHICH worker is answering, so a restart confirms a NEW process rather than the
   *  outgoing one. Null ⇒ nothing readable there. */
  readInstance?: (port: number, timeoutMs?: number) => Promise<number | null>;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function restartCommand(args: string[] = [], deps: RestartDeps = {}): Promise<number> {
  const force = args.includes('--force');
  const graceful = !force;
  const port = deps.port ?? Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
  const sm = deps.sm ?? getServiceManager();
  const probe = deps.probe ?? probeHealthOnce;
  const readInstance = deps.readInstance ?? readWorkerInstance;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  // Identify the OUTGOING worker BEFORE touching it. Without this the poll below cannot tell a
  // restarted worker from the old one still holding the port — see the loop for why that matters.
  const before = await readInstance(port, 1500);

  console.log(`Restarting captain-memo worker${force ? ' (forced)' : ''}…`);
  await restartWorker(sm, WORKER_SERVICE, { port, graceful });

  // restartWorker() is synchronous here, so the worker should already be down when polling starts.
  const waitMs = deps.waitMs ?? 8_000;
  const secs = Math.round(waitMs / 1000);

  // SUCCESS MEANS A NEW PROCESS, NOT A REACHABLE ONE. This used to accept any `/health` 200 — but
  // `/health` answers {healthy:true} from ANY live process and carries no identity, so an outgoing
  // worker that has not finished exiting is indistinguishable from a restarted one, and the command
  // would report success over a restart that then failed. Comparing the instance stamp removes the
  // ambiguity rather than narrowing the race.
  const deadline = now() + waitMs;
  while (now() < deadline) {
    const cur = await readInstance(port, 1500);
    if (cur !== null && (before === null || cur > before)) {
      console.log('✓ worker is healthy');
      return 0;
    }
    // Nothing was running beforehand, so there is no old instance to be confused with — a plain
    // health answer is proof enough, and covers a worker whose /stats is still warming up.
    if (before === null && (await probe(port, 1500))) {
      console.log('✓ worker is healthy');
      return 0;
    }
    await sleep(500);
  }

  // Unconfirmed is reported as unconfirmed, never as success.
  console.error(`worker did not come back as a new process within ${secs}s — check \`captain-memo status\``);
  return 1;
}
