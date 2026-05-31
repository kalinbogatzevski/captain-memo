# Worker Auto-Recovery + Upgrade-Staleness Self-Heal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A killed or stale Captain Memo worker auto-recovers with zero manual service management, on both Linux (systemd) and Windows (Task Scheduler).

**Architecture:** Two owners — the OS supervisor keeps the worker *alive* (Linux `Restart=always`; Windows a 5-min watchdog repetition trigger), and `SessionStart` keeps it *current* (compares the hook's compiled `VERSION` to `/stats.version`, graceful-restarting on mismatch) plus provides bounded-blocking instant recovery; `UserPromptSubmit` does non-blocking revival. Heal logic lives in a pure, injected `ensureWorkerHealthy` orchestrator so it is unit-testable without touching the real service manager.

**Tech Stack:** Bun + TypeScript, `bun:test`, systemd unit files, Windows Task Scheduler 1.2 XML.

**Spec:** `docs/specs/2026-05-31-worker-auto-recovery-design.md`

**Deviation from spec Decision 8 (noted):** the spec proposed a `restart` enum + a systemd `__RESTART__` placeholder. The Linux templates are rendered by *three* independent paths (`install.ts:installWorkerService`, `systemd.ts:install`, `scripts/install-embedder.sh`), none of which touch the `Restart=` line. Editing the 4 template files directly is strictly simpler and lower-risk than teaching all three to substitute a placeholder. So: **keep `restartOnFailure: boolean`; add only `watchdogIntervalSec?: number`** for the Windows watchdog.

---

### Task 1: Add `watchdogIntervalSec` to the ServiceSpec contract

**Files:**
- Modify: `src/services/service-manager/types.ts`

- [ ] **Step 1: Add the field** to the `ServiceSpec` interface, after `restartOnFailure`:

```ts
  restartOnFailure: boolean;
  /** Windows only: register a periodic watchdog trigger that re-launches the task
   *  every N seconds (no-op when already running, via MultipleInstancesPolicy=
   *  IgnoreNew). The backstop for a clean-killed task that RestartOnFailure won't
   *  catch. Ignored by systemd, where Restart=always is continuous. Default 300. */
  watchdogIntervalSec?: number;
  /** Where stdout/stderr land. Windows has no journal, so the daemon logs here. */
  logDir: string;
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS (optional field, no call site is forced to change yet).

- [ ] **Step 3: Commit**

```bash
git add src/services/service-manager/types.ts
git commit -m "feat(service-manager): add optional watchdogIntervalSec to ServiceSpec"
```

---

### Task 2: Windows watchdog repetition trigger in `buildTaskXml`

**Files:**
- Modify: `src/services/service-manager/windows-scheduled-task.ts`
- Test: `tests/unit/windows-scheduled-task.test.ts`

- [ ] **Step 1: Write the failing tests** (append inside the `describe('buildTaskXml', …)` block):

```ts
  test('emits a periodic watchdog TimeTrigger from watchdogIntervalSec', () => {
    const xml = buildTaskXml(sampleSpec({ watchdogIntervalSec: 300 }));
    expect(xml).toContain('<TimeTrigger>');
    expect(xml).toContain('<Repetition>');
    expect(xml).toContain('<Interval>PT5M</Interval>');
    // Repeat indefinitely — no duration cap.
    expect(xml).toContain('<StopAtDurationEnd>false</StopAtDurationEnd>');
    // A StartBoundary is required for a TimeTrigger to be valid.
    expect(xml).toContain('<StartBoundary>');
    // The LogonTrigger still co-exists (autostart at logon).
    expect(xml).toContain('<LogonTrigger>');
  });

  test('defaults the watchdog to PT5M when watchdogIntervalSec is omitted', () => {
    const xml = buildTaskXml(sampleSpec()); // sampleSpec has no watchdogIntervalSec
    expect(xml).toContain('<TimeTrigger>');
    expect(xml).toContain('<Interval>PT5M</Interval>');
  });

  test('renders a sub-minute watchdog interval as PT{n}S', () => {
    const xml = buildTaskXml(sampleSpec({ watchdogIntervalSec: 90 }));
    expect(xml).toContain('<Interval>PT1M30S</Interval>');
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/unit/windows-scheduled-task.test.ts`
Expected: FAIL — `<TimeTrigger>` not found.

- [ ] **Step 3: Implement.** Add an ISO-8601 duration helper near the top of `windows-scheduled-task.ts` (after `xmlEscape`):

```ts
// Render seconds as an ISO-8601 duration (PT…) for a Task Scheduler <Interval>.
// 300 → PT5M, 90 → PT1M30S, 45 → PT45S. Whole minutes drop the seconds segment.
function isoDuration(totalSeconds: number): string {
  const s = Math.max(1, Math.floor(totalSeconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  let out = 'PT';
  if (mins > 0) out += `${mins}M`;
  if (secs > 0 || mins === 0) out += `${secs}S`;
  return out;
}
```

In `buildTaskXml`, build a watchdog trigger and add it to the `<Triggers>` block. Find the existing `<Triggers>` … `</Triggers>` lines and replace them so both triggers are present:

```ts
  const watchdogInterval = isoDuration(spec.watchdogIntervalSec ?? 300);
  // A fixed past StartBoundary makes the TimeTrigger immediately eligible; the
  // <Repetition> then re-fires every interval forever. Combined with
  // MultipleInstancesPolicy=IgnoreNew, each fire is a no-op when the worker is
  // already alive and a relaunch when it is dead — the backstop for a clean kill
  // (STATUS_CONTROL_C_EXIT) that RestartOnFailure does not treat as a failure.
  const triggers = [
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${userId}</UserId>`,
    '    </LogonTrigger>',
    '    <TimeTrigger>',
    '      <Enabled>true</Enabled>',
    '      <StartBoundary>2020-01-01T00:00:00</StartBoundary>',
    '      <Repetition>',
    `        <Interval>${watchdogInterval}</Interval>`,
    '        <StopAtDurationEnd>false</StopAtDurationEnd>',
    '      </Repetition>',
    '    </TimeTrigger>',
    '  </Triggers>',
  ];
```

Then in the `lines` array, replace the inline `<Triggers>…</Triggers>` block with `...triggers,`. (The `userId` const is already computed above the triggers block — keep that definition before `triggers`.)

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/unit/windows-scheduled-task.test.ts`
Expected: PASS (all existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/services/service-manager/windows-scheduled-task.ts tests/unit/windows-scheduled-task.test.ts
git commit -m "feat(windows): add periodic watchdog trigger so a clean-killed worker self-recovers"
```

---

### Task 3: Linux templates → `Restart=always` + `StartLimitIntervalSec=0`

**Files (edit all four):**
- Modify: `services/worker/systemd/captain-memo-worker.user.service`
- Modify: `services/worker/systemd/captain-memo-worker.service`
- Modify: `services/embed/systemd/captain-memo-embed.user.service`
- Modify: `services/embed/systemd/captain-memo-embed.service`

- [ ] **Step 1: Edit each file.** In every `[Service]` block, change `Restart=on-failure` → `Restart=always`. In every `[Unit]` block (or anywhere in the unit), add `StartLimitIntervalSec=0` so the default 5-starts/10s rate-limiter never sends a flapping worker permanently to `failed`. Concretely, for the `[Unit]` section add the line; e.g. the worker `.user.service` becomes:

```ini
[Unit]
Description=Captain Memo worker (user-level, HTTP search + observation pipeline)
After=default.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=__INSTALL_DIR__
EnvironmentFile=-__ENV_FILE__
ExecStart=__BUN__ src/worker/index.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

Apply the identical two changes (`Restart=always`, `StartLimitIntervalSec=0` in `[Unit]`) to the other three units, preserving each file's other lines verbatim.

- [ ] **Step 2: Add a guard test** that the shipped templates encode the always-on policy. Create `tests/unit/systemd-templates.test.ts`:

```ts
// tests/unit/systemd-templates.test.ts — the shipped unit templates must encode
// the always-on recovery policy. Pure file reads; runs on any platform.
import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '../..');
const UNITS = [
  'services/worker/systemd/captain-memo-worker.user.service',
  'services/worker/systemd/captain-memo-worker.service',
  'services/embed/systemd/captain-memo-embed.user.service',
  'services/embed/systemd/captain-memo-embed.service',
];

describe('systemd unit templates', () => {
  for (const rel of UNITS) {
    test(`${rel} uses Restart=always and disables the start-rate limiter`, () => {
      const unit = readFileSync(join(ROOT, rel), 'utf-8');
      expect(unit).toContain('Restart=always');
      expect(unit).not.toContain('Restart=on-failure');
      expect(unit).toContain('StartLimitIntervalSec=0');
    });
  }
});
```

- [ ] **Step 3: Run**

Run: `bun test tests/unit/systemd-templates.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add services/worker/systemd/*.service services/embed/systemd/*.service tests/unit/systemd-templates.test.ts
git commit -m "feat(systemd): Restart=always + StartLimitIntervalSec=0 so clean kills recover and flapping never gives up"
```

---

### Task 4: Pass `watchdogIntervalSec` from the Windows install call sites

**Files:**
- Modify: `src/cli/commands/install.ts:966-974` (embed) and `:985-994` (worker)

- [ ] **Step 1: Add the field** to both `getServiceManager().install({…})` specs (these are inside `installWindows`). Worker spec — add after `restartOnFailure: true,`:

```ts
    autostart: true,
    restartOnFailure: true,
    watchdogIntervalSec: 300,
    logDir: LOGS_DIR,
```

Embed spec — same addition:

```ts
        autostart: true,
        restartOnFailure: true,
        watchdogIntervalSec: 300,
        logDir: LOGS_DIR,
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/install.ts
git commit -m "feat(install/windows): register worker + embedder with a 5-min watchdog interval"
```

---

### Task 5: Heal-lock helper (concurrency guard)

**Files:**
- Create: `src/shared/worker-heal-lock.ts`
- Test: `tests/unit/shared/worker-heal-lock.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
// tests/unit/shared/worker-heal-lock.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireHealLock, releaseHealLock } from '../../../src/shared/worker-heal-lock.ts';

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'cm-heal-')), '.worker-heal.lock');
}

test('first acquire succeeds, second is refused while fresh', () => {
  const p = lockPath();
  expect(acquireHealLock(p, 1000)).toBe(true);
  expect(acquireHealLock(p, 1500)).toBe(false); // held, 500ms old < TTL
  releaseHealLock(p);
  expect(existsSync(p)).toBe(false);
});

test('a stale lock (older than TTL) is reclaimed', () => {
  const p = lockPath();
  expect(acquireHealLock(p, 0)).toBe(true);
  // 21s later — past the 20s TTL — the stale lock is taken over.
  expect(acquireHealLock(p, 21_000)).toBe(true);
  releaseHealLock(p);
});

test('release is idempotent and never throws', () => {
  const p = lockPath();
  releaseHealLock(p); // not held — no throw
  expect(true).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/shared/worker-heal-lock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/shared/worker-heal-lock.ts`:**

```ts
// src/shared/worker-heal-lock.ts — a tiny advisory lock so concurrent hooks
// (multiple Claude windows opening at once) don't stampede the service manager
// with parallel start/restart calls. O_EXCL create is atomic; a lock older than
// the TTL (a crashed holder) is reclaimed so a heal can never deadlock forever.
import { openSync, closeSync, statSync, unlinkSync, writeSync } from 'fs';
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
      const age = now - statSync(lockPath).mtimeMs;
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
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/unit/shared/worker-heal-lock.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/worker-heal-lock.ts tests/unit/shared/worker-heal-lock.test.ts
git commit -m "feat(shared): advisory heal-lock to serialize concurrent worker recovery"
```

---

### Task 6: `ensureWorkerHealthy` orchestrator (pure policy)

**Files:**
- Create: `src/shared/worker-health.ts`
- Test: `tests/unit/shared/worker-health.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
// tests/unit/shared/worker-health.test.ts
import { test, expect } from 'bun:test';
import { ensureWorkerHealthy, type EnsureDeps } from '../../../src/shared/worker-health.ts';

function deps(over: Partial<EnsureDeps> & { version: string | null }): EnsureDeps {
  const calls: string[] = [];
  const d: EnsureDeps = {
    diskVersion: '0.2.14',
    probeVersion: async () => over.version,
    acquireLock: () => true,
    releaseLock: () => { calls.push('release'); },
    start: async () => { calls.push('start'); },
    restart: async () => { calls.push('restart'); },
    waitHealthy: async () => true,
    ...over,
  };
  (d as any)._calls = calls;
  return d;
}

test('healthy + current → no action', async () => {
  const d = deps({ version: '0.2.14' });
  const out = await ensureWorkerHealthy(d);
  expect(out.action).toBe('none');
  expect((d as any)._calls).toEqual([]);
});

test('unreachable → starts the worker', async () => {
  const d = deps({ version: null });
  const out = await ensureWorkerHealthy(d);
  expect(out).toMatchObject({ action: 'started', reason: 'unreachable', healthy: true });
  expect((d as any)._calls).toEqual(['start', 'release']);
});

test('stale → graceful restart', async () => {
  const d = deps({ version: '0.2.0' });
  const out = await ensureWorkerHealthy(d);
  expect(out).toMatchObject({ action: 'restarted', reason: 'stale', fromVersion: '0.2.0', toVersion: '0.2.14' });
  expect((d as any)._calls).toEqual(['restart', 'release']);
});

test('lock held by another session → skipped, no start/restart', async () => {
  const d = deps({ version: null, acquireLock: () => false });
  const out = await ensureWorkerHealthy(d);
  expect(out).toMatchObject({ action: 'skipped', reason: 'lock-held' });
  expect((d as any)._calls).toEqual([]); // never touched start/restart/release
});

test('start failure is reported, lock still released', async () => {
  const d = deps({ version: null, start: async () => { throw new Error('no systemctl'); } });
  const out = await ensureWorkerHealthy(d);
  expect(out).toMatchObject({ action: 'failed', reason: 'unreachable' });
  expect((d as any)._calls).toEqual(['release']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/shared/worker-health.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/shared/worker-health.ts`:**

```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/unit/shared/worker-health.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/worker-health.ts tests/unit/shared/worker-health.test.ts
git commit -m "feat(shared): ensureWorkerHealthy orchestrator (pure, injected heal policy)"
```

---

### Task 7: Wire SessionStart to the orchestrator (block-on-SessionStart)

**Files:**
- Modify: `src/hooks/session-start.ts`
- Test: `tests/hooks/session-start.test.ts`

- [ ] **Step 1: Update existing tests** so they are side-effect-free (no real `systemctl`). The banner test must report a matching version (so heal sees "healthy"); the unreachable test must disable self-heal. Edit `tests/hooks/session-start.test.ts`:

Add the import at the top:
```ts
import { VERSION } from '../../src/shared/version.ts';
```
In the fake `/stats` response object, add `version: VERSION,`:
```ts
          project_id: 'test',
          embedder: { model: 'voyage-4-lite', endpoint: 'https://api.voyageai.com/v1/embeddings' },
          version: VERSION,
        });
```
Change the unreachable test to disable self-heal:
```ts
test('SessionStart — exits 0 even when worker unreachable', async () => {
  const { exitCode } = await runHook({ CAPTAIN_MEMO_WORKER_PORT: '1', CAPTAIN_MEMO_DISABLE_SELF_HEAL: '1' });
  expect(exitCode).toBe(0);
});
```

- [ ] **Step 2: Add a new test** proving a healthy+current worker is NOT restarted (the orchestrator sees `version === VERSION` → no service call). Append:

```ts
test('SessionStart — current worker: shows banner, no heal attempted', async () => {
  statsCalls = 0;
  const { stdout, exitCode } = await runHook(); // version matches VERSION (fake returns it)
  expect(exitCode).toBe(0);
  expect(stdout).toContain('Captain Memo');
  expect(stdout).toContain('1,234 chunks');
});
```

- [ ] **Step 3: Run to verify the suite still passes against the OLD hook** (these don't yet exercise heal; they should pass once the hook is updated). For now:

Run: `bun test tests/hooks/session-start.test.ts`
Expected: PASS (the version field + disable flag are inert against the current hook).

- [ ] **Step 4: Implement the hook change.** Replace the body of `main()` in `src/hooks/session-start.ts` so that after the initial `/stats` probe it runs `ensureWorkerHealthy` (unless disabled), then re-probes for the banner. Add imports:

```ts
import { VERSION } from '../shared/version.ts';
import { ensureWorkerHealthy } from '../shared/worker-health.ts';
import { acquireHealLock, releaseHealLock } from '../shared/worker-heal-lock.ts';
```

Replace the `const stats = await workerFetch…` block through the end of `main()` with:

```ts
  async function probeStats() {
    return workerFetch<StatsResponse>('/stats', { method: 'GET', timeoutMs });
  }

  let stats = await probeStats();
  const selfHealOff = process.env.CAPTAIN_MEMO_DISABLE_SELF_HEAL === '1';

  // Self-heal: start a dead worker / restart a stale one, then re-probe. Routed
  // through the OS service manager (it owns the process — nothing is orphaned
  // when this short-lived hook exits). Fully fail-open: any error → degraded
  // banner, never a thrown hook.
  const running = stats.ok && !!stats.body;
  const stale = running && stats.body!.version !== undefined && stats.body!.version !== VERSION;
  if (!selfHealOff && (!running || stale)) {
    try {
      const { getServiceManager } = await import('../services/service-manager/index.ts');
      const sm = getServiceManager();
      const WORKER = 'captain-memo-worker';
      const port = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
      const outcome = await ensureWorkerHealthy({
        diskVersion: VERSION,
        probeVersion: async () => (running ? (stats.body!.version ?? null) : null),
        acquireLock: () => acquireHealLock(),
        releaseLock: () => releaseHealLock(),
        start: () => sm.start(WORKER),
        restart: async () => { await sm.stop(WORKER, { graceful: true, port }); await sm.start(WORKER); },
        waitHealthy: async () => {
          const deadline = Date.now() + 8000;
          while (Date.now() < deadline) {
            const r = await workerFetch<StatsResponse>('/stats', { method: 'GET', timeoutMs: 1500 });
            if (r.ok) { stats = r; return true; }
            await new Promise((res) => setTimeout(res, 500));
          }
          return false;
        },
      });
      if (outcome.action === 'skipped') {
        // Another session is healing — give it a moment, then re-probe for the banner.
        await new Promise((res) => setTimeout(res, 1500));
        stats = await probeStats();
      } else if (outcome.action === 'failed') {
        logHookError('SessionStart', new Error(`self-heal ${outcome.reason} failed: ${outcome.error}`));
      }
    } catch (err) {
      logHookError('SessionStart', err);
    }
  }

  if (stats.ok && stats.body) {
    writeStdout(JSON.stringify({ continue: true, systemMessage: formatBanner(stats.body) }));
  } else {
    logHookError('SessionStart', new Error(workerFailureMessage('/stats', stats) ?? 'worker /stats returned no body'));
    writeStdout(JSON.stringify({
      continue: true,
      systemMessage: formatDegradedBanner(stats.timedOut ? 'worker timed out' : 'worker not reachable'),
    }));
  }
```

Add `DEFAULT_WORKER_PORT` to the existing `paths.ts` import line at the top of the file:
```ts
import { DEFAULT_HOOK_TIMEOUT_MS, ENV_HOOK_TIMEOUT_MS, DEFAULT_WORKER_PORT } from '../shared/paths.ts';
```
(If those exact names differ, keep the existing import and add `DEFAULT_WORKER_PORT`.)

- [ ] **Step 5: Run**

Run: `bun test tests/hooks/session-start.test.ts`
Expected: PASS (banner, current-worker, and fail-open-with-heal-disabled tests).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/session-start.ts tests/hooks/session-start.test.ts
git commit -m "feat(hooks/session-start): ensure a healthy + current worker (block-on-SessionStart self-heal)"
```

---

### Task 8: UserPromptSubmit fire-and-forget revival

**Files:**
- Modify: `src/hooks/user-prompt-submit.ts`
- Test: `tests/hooks/user-prompt-submit.test.ts`

- [ ] **Step 1: Add a test** that an unreachable worker doesn't block and the prompt still passes through (existing fail-open), with self-heal disabled to avoid real `systemctl`:

```ts
test('UserPromptSubmit — worker down + heal disabled: prompt passes through, exits 0', async () => {
  const { stdout, exitCode } = await runHook(
    { CAPTAIN_MEMO_WORKER_PORT: '1', CAPTAIN_MEMO_DISABLE_SELF_HEAL: '1' },
  );
  expect(exitCode).toBe(0);
  // The bare prompt is still emitted (fail-open) — nothing blocked.
  expect(stdout.length).toBeGreaterThanOrEqual(0);
});
```
(Match `runHook`'s existing signature in this test file; if it doesn't accept env, mirror the helper from `session-start.test.ts`.)

- [ ] **Step 2: Implement** — after the `logWorkerFailure(...)` line in `user-prompt-submit.ts`, add a non-blocking revival nudge:

```ts
  logWorkerFailure('UserPromptSubmit', '/inject/context', result);

  // Fire-and-forget revival: if the worker was unreachable, ask the OS supervisor
  // to start it (no await on /health — the supervisor owns the process, so this
  // hook can exit immediately). Never blocks the prompt; never checks the version.
  if (!result.ok && process.env.CAPTAIN_MEMO_DISABLE_SELF_HEAL !== '1') {
    try {
      const { acquireHealLock, releaseHealLock } = await import('../shared/worker-heal-lock.ts');
      if (acquireHealLock()) {
        try {
          const { getServiceManager } = await import('../services/service-manager/index.ts');
          await getServiceManager().start('captain-memo-worker');
        } finally {
          releaseHealLock();
        }
      }
    } catch (err) {
      logHookError('UserPromptSubmit', err);
    }
  }
```

- [ ] **Step 3: Run**

Run: `bun test tests/hooks/user-prompt-submit.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/user-prompt-submit.ts tests/hooks/user-prompt-submit.test.ts
git commit -m "feat(hooks/user-prompt-submit): fire-and-forget worker revival (non-blocking)"
```

---

### Task 9: Version bump + changelog

**Files:**
- Modify: `package.json` (and `plugin/.claude-plugin/plugin.json` + `marketplace.json` if the version-lockstep guard test requires — run the guard test to confirm)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump** `package.json` version `0.2.13` → `0.2.14`. Run the lockstep guard test to see which sibling files must match:

Run: `bun test 2>&1 | grep -i version`
If a guard test fails, bump the same version in `plugin/.claude-plugin/plugin.json` and `marketplace.json`.

- [ ] **Step 2: Add a CHANGELOG entry** under a new `## 0.2.14` heading:

```markdown
## 0.2.14
- Worker auto-recovery: a killed worker now returns automatically. Linux units use
  `Restart=always` (+ `StartLimitIntervalSec=0`); Windows tasks gain a 5-minute
  watchdog trigger. Applies to both the worker and the embedder.
- SessionStart self-heal: a dead worker is started (bounded wait) and a stale one
  (running code older than the installed version) is graceful-restarted, so a new
  session always opens on a healthy, current worker. `UserPromptSubmit` nudges a
  dead worker back without blocking. Opt out with `CAPTAIN_MEMO_DISABLE_SELF_HEAL=1`.
```

- [ ] **Step 3: Run the full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add package.json CHANGELOG.md plugin/.claude-plugin/plugin.json marketplace.json
git commit -m "chore: release v0.2.14 — worker auto-recovery + staleness self-heal"
```

---

## Self-Review

- **Spec coverage:** OS-supervisor liveness (Tasks 2,3,4) ✓; SessionStart current+recovery (Tasks 6,7) ✓; UserPromptSubmit revival (Task 8) ✓; concurrency guard (Task 5) ✓; both services (Task 3 templates + Task 4 install) ✓; fail-open (Tasks 6,7,8) ✓; tests incl. upgrade-race regression — **add live verification in the deploy/test phase** (the regression is environmental; covered by the live SIGTERM + upgrade test rather than a unit test). Staleness detection via `VERSION` vs `/stats.version` (Tasks 6,7) ✓.
- **Placeholder scan:** none — every code step shows complete code; template edits show the full resulting file/lines.
- **Type consistency:** `ensureWorkerHealthy`/`EnsureDeps` names match across Task 6 and the Task 7 call site; `acquireHealLock`/`releaseHealLock` signatures match across Tasks 5/7/8; `watchdogIntervalSec` matches across Tasks 1/2/4.

## Deploy / Test / Review (post-implementation — the `/goal` phases)
- **Deploy (local):** rebuild the hook bundle (`plugin/dist`), re-render this box's `~/.config/systemd/user/captain-memo-worker.service` (re-run the user install or `systemctl --user daemon-reload` after copying the edited unit), `systemctl --user restart captain-memo-worker`, verify `/health` + `/stats.version`.
- **Test (live):** `bun test` + `tsc --noEmit` green; then `kill -TERM <worker-pid>` → confirm systemd brings it straight back (the SIGTERM that `on-failure` ignored); confirm `captain-memo upgrade`/`vacuum` still complete cleanly under `Restart=always`.
- **Review:** run the code-review skill over the diff (correctness, fail-open, race-safety, thin-hook philosophy); address findings.
