// src/shared/worker-heal-lock.ts — a tiny advisory lock so concurrent hooks
// (multiple Claude windows opening at once) don't stampede the service manager
// with parallel start/restart calls. O_EXCL create is atomic; a lock older than
// the TTL (a crashed holder) is reclaimed so a heal can never deadlock forever.
import { openSync, closeSync, readFileSync, unlinkSync, writeSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './paths.ts';

export const HEAL_LOCK_PATH = join(DATA_DIR, '.worker-heal.lock');
export const HEAL_LOCK_TTL_MS = 20_000;

/** Try to acquire the heal lock. `lockPath`/`now` are injectable for tests. */
export function acquireHealLock(lockPath: string = HEAL_LOCK_PATH, now: number = Date.now()): boolean {
  try {
    const fd = openSync(lockPath, 'wx'); // O_CREAT | O_EXCL | O_WRONLY — fails if it exists
    writeSync(fd, String(now));
    closeSync(fd);
    return true;
  } catch {
    try {
      // Staleness is judged from the timestamp we WROTE into the file (deterministic
      // and clock-injectable), not the filesystem mtime (unreliable across FSes). A
      // corrupt/empty lock (crashed mid-write → NaN) reads as epoch 0 → reclaimed.
      const stamp = Number(readFileSync(lockPath, 'utf-8').trim());
      const age = now - (Number.isFinite(stamp) ? stamp : 0);
      if (age > HEAL_LOCK_TTL_MS) {
        unlinkSync(lockPath);
        const fd = openSync(lockPath, 'wx');
        writeSync(fd, String(now));
        closeSync(fd);
        return true;
      }
    } catch {
      // lost the race or fs error — treat as not acquired
    }
    return false;
  }
}

/** Release the heal lock. Idempotent — a missing lock is fine. */
export function releaseHealLock(lockPath: string = HEAL_LOCK_PATH): void {
  try { unlinkSync(lockPath); } catch { /* already gone */ }
}
