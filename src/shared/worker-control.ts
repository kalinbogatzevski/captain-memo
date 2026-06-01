// src/shared/worker-control.ts — impure helper that drives the OS supervisor to
// REPLACE the worker, not merely (re)start it.
//
// Why this exists: a bare start() is NOT enough to recover a ZOMBIE worker
// (process alive, but its HTTP server is dead so /health never answers). On
// Windows the worker runs as a Scheduled Task with MultipleInstancesPolicy=
// IgnoreNew, so while the zombie process still holds the task "Running", a
// Start-ScheduledTask is a silent no-op — and the zombie may also still own the
// port, so nothing fresh can bind. This defeated every autonomous recovery path
// in the field (2026-06-01): the self-heal fired for ~2.7h ("did not become
// healthy within 8s") until an operator hard-killed the process by hand.
//
// restartWorker first force-stops (stop with force:true → Windows hard-kills
// whatever still holds the worker port; systemd's `systemctl stop` already
// guarantees the kill), THEN starts. So the next start binds a fresh worker
// instead of no-opping over the corpse.

import type { ServiceManager } from '../services/service-manager/types.ts';

export interface RestartOptions {
  /** Worker HTTP port. Windows stop(force) hard-kills whatever still LISTENS here. */
  port: number;
  /** POST /shutdown first so SQLite drains cleanly. Use for a healthy-but-stale
   *  worker. Skip (default) for a broken/zombie worker — it will not answer, and
   *  skipping avoids the bounded /shutdown wait on the recovery path. */
  graceful?: boolean;
}

/** Reclaim (force-stop, guaranteeing the process is dead) then start the worker. */
export async function restartWorker(
  sm: ServiceManager,
  name: string,
  opts: RestartOptions,
): Promise<void> {
  await sm.stop(name, { graceful: opts.graceful ?? false, port: opts.port, force: true });
  await sm.start(name);
}
