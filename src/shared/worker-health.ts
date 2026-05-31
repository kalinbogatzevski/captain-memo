// src/shared/worker-health.ts — pure orchestration for "ensure a healthy, current
// worker". All side effects are injected (probe/start/restart/wait/lock) so the
// policy is unit-testable without a real service manager or HTTP. Callers (the
// hooks) wire the real implementations in.

export type WorkerHealthOutcome =
  | { action: 'none'; reason: 'healthy' }
  | { action: 'skipped'; reason: 'lock-held' }
  | { action: 'started'; reason: 'unreachable'; healthy: boolean }
  | { action: 'restarted'; reason: 'stale'; fromVersion: string; toVersion: string; healthy: boolean }
  | { action: 'failed'; reason: 'unreachable' | 'stale'; error: string };

export interface EnsureDeps {
  /** Version the on-disk code SHOULD be running (the hook's own compiled VERSION). */
  diskVersion: string;
  /** Probe the worker; resolves its reported version, or null if unreachable. */
  probeVersion: () => Promise<string | null>;
  /** Acquire the heal lock; true if acquired, false if another session holds it. */
  acquireLock: () => boolean;
  releaseLock: () => void;
  /** Start the worker via the OS supervisor. */
  start: () => Promise<void>;
  /** Graceful restart (stop+start) via the OS supervisor. */
  restart: () => Promise<void>;
  /** Wait (bounded) until the worker answers; true if it came up. */
  waitHealthy: () => Promise<boolean>;
}

export async function ensureWorkerHealthy(deps: EnsureDeps): Promise<WorkerHealthOutcome> {
  const version = await deps.probeVersion();

  // Reachable AND on the current version → nothing to do (the common case).
  if (version !== null && version === deps.diskVersion) {
    return { action: 'none', reason: 'healthy' };
  }

  // Acting requires the lock; if another session is already healing, defer.
  if (!deps.acquireLock()) {
    return { action: 'skipped', reason: 'lock-held' };
  }
  try {
    if (version === null) {
      try {
        await deps.start();
      } catch (e) {
        return { action: 'failed', reason: 'unreachable', error: (e as Error).message };
      }
      return { action: 'started', reason: 'unreachable', healthy: await deps.waitHealthy() };
    }
    // Reachable but version !== disk → stale code, graceful restart.
    try {
      await deps.restart();
    } catch (e) {
      return { action: 'failed', reason: 'stale', error: (e as Error).message };
    }
    return {
      action: 'restarted', reason: 'stale',
      fromVersion: version, toVersion: deps.diskVersion,
      healthy: await deps.waitHealthy(),
    };
  } finally {
    deps.releaseLock();
  }
}
