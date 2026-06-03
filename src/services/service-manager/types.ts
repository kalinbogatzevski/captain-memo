// src/services/service-manager/types.ts — OS-agnostic daemon supervision contract.
//
// One interface, two impls (systemd on Linux, Scheduled Task on Windows), one
// factory (./index.ts). The five management commands — install/uninstall/upgrade/
// vacuum/doctor — call ONLY this interface, never `systemctl`/`schtasks` directly.
// A macOS launchd impl can drop in later without touching any command.

export type ServiceState = 'running' | 'stopped' | 'not-installed' | 'failed';

export interface ServiceSpec {
  /** Canonical service id, e.g. 'captain-memo-worker' / 'captain-memo-embed'. */
  name: string;
  description: string;
  /** Full argv to launch, e.g. [bunPath, 'src/worker/index.ts']. */
  exec: string[];
  workingDir: string;
  /** worker.env path. Linux: written into the systemd EnvironmentFile= line.
   *  Windows: recorded only — the daemon loads it in-process via loadWorkerEnv(). */
  envFile?: string;
  /** Start automatically at logon (Windows) / boot (systemd WantedBy). */
  autostart: boolean;
  restartOnFailure: boolean;
  /** Windows only: register a periodic watchdog trigger that re-launches the task
   *  every N seconds (a no-op when already running, via MultipleInstancesPolicy=
   *  IgnoreNew). The backstop for a clean-killed task that RestartOnFailure won't
   *  catch. Ignored by systemd, where Restart=always is continuous. Default 300. */
  watchdogIntervalSec?: number;
  /** Where stdout/stderr land. Windows has no journal, so the daemon logs here. */
  logDir: string;
}

export interface StopOptions {
  /** Try a clean shutdown first (POST /shutdown to `port`) before terminating.
   *  Used by upgrade/vacuum so SQLite locks are released cleanly. */
  graceful?: boolean;
  port?: number;
  /** Guarantee the worker PROCESS is actually gone, not just that the supervisor
   *  was asked to stop it. Windows: Stop-ScheduledTask does NOT reliably terminate
   *  a detached/zombie worker, so additionally hard-kill whatever still holds
   *  `port` (field 2026-06-01). systemd: no-op — `systemctl stop` already kills. */
  force?: boolean;
}

export interface ServiceManager {
  install(spec: ServiceSpec): Promise<void>;
  remove(name: string): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string, opts?: StopOptions): Promise<void>;
  /** Atomically replace the worker (stop+start as ONE supervisor job, so a caller dying
   *  mid-way cannot strand it stopped). opts mirror StopOptions for the force/graceful path. */
  restart(name: string, opts?: StopOptions): Promise<void>;
  status(name: string): Promise<ServiceState>;
  isActive(name: string): Promise<boolean>;
  enable(name: string): Promise<void>;
  disable(name: string): Promise<void>;
}
