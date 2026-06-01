// src/shared/worker-watchdog.ts — pure policy for the AUTONOMOUS watchdog.
//
// The hooks only self-heal at session boundaries (SessionStart / UserPromptSubmit).
// When no Claude session is active, a dead/zombie worker would stay down. This
// policy is fired by the `captain-memo-watchdog` Scheduled Task on a 5-min
// TimeTrigger — a SEPARATE task from the worker, which is essential: the worker
// task is MultipleInstancesPolicy=IgnoreNew, so while a zombie holds it "Running"
// the worker task's OWN relaunch trigger no-ops. A distinct task has its own
// instance state and always fires.
//
// All side effects are injected so the policy is unit-testable without a real
// service manager, HTTP, or filesystem lock. The CLI command wires the real ones.

export type WatchdogOutcome =
  | { action: 'none'; reason: 'healthy' }
  | { action: 'skipped'; reason: 'lock-held' }
  | { action: 'reclaimed'; healthy: boolean }
  | { action: 'failed'; error: string };

export interface WatchdogDeps {
  /** True if the worker answers /health right now. */
  probeHealthy: () => Promise<boolean>;
  /** Shared heal lock — false if a hook/another watchdog is already healing. */
  acquireLock: () => boolean;
  releaseLock: () => void;
  /** Force-reclaim (hard-kill the port owner) then start the worker. */
  reclaim: () => Promise<void>;
  /** Wait (bounded) until the worker answers again; true if it came back. */
  waitHealthy: () => Promise<boolean>;
}

export async function runWorkerWatchdog(deps: WatchdogDeps): Promise<WatchdogOutcome> {
  // Healthy is the overwhelmingly common case (every 5 min, worker fine) — do the
  // cheap probe first and bail before touching the lock so we never contend with
  // a real heal in progress.
  if (await deps.probeHealthy()) return { action: 'none', reason: 'healthy' };

  // Acting requires the lock; if a hook self-heal (or another watchdog tick) is
  // already on it, defer rather than double-reclaim.
  if (!deps.acquireLock()) return { action: 'skipped', reason: 'lock-held' };
  try {
    await deps.reclaim();
    // Hold the lock through the health wait so a concurrent healer can't also act.
    return { action: 'reclaimed', healthy: await deps.waitHealthy() };
  } catch (e) {
    return { action: 'failed', error: (e as Error).message };
  } finally {
    deps.releaseLock();
  }
}
