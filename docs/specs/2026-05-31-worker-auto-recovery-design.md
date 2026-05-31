# Captain Memo — Worker Auto-Recovery + Upgrade-Staleness Self-Heal (v0.2.14)

- **Date:** 2026-05-31
- **Target version:** v0.2.14 (next patch from 0.2.13)
- **Status:** Approved design → implementation
- **Author:** Kalin Bogatzevski (design assisted)

## 1. Summary

Two reliability gaps leave the worker dead or stale with **no automatic
recovery**, which is unacceptable for an OSS tool ("don't ask users to
start/stop services").

1. **Clean-signal kills are not auto-restarted.** systemd `Restart=on-failure`
   *excludes* `SIGHUP`/`SIGINT`/`SIGTERM`/`SIGPIPE` (treated as clean stops), and
   Windows Task Scheduler's `RestartOnFailure` does not fire for a `Ctrl-C` exit
   (`STATUS_CONTROL_C_EXIT` / `0xC000013A`); the task's only autostart is a
   `LogonTrigger`. A worker killed this way stays down until a manual
   `Start-ScheduledTask` / `systemctl --user start` or a fresh logon. This is the
   exact failure observed on Windows on 2026-05-31 (task `Ready`, last run killed
   with `0xC000013A`, no recurring trigger).
2. **Stale code after an update.** After the on-disk code is updated, the running
   worker keeps serving the old code until its *process* is replaced, so
   `/stats.version` lags `package.json` (observed: running v0.2.0 while disk had
   v0.2.8). Nothing restarts the worker on a code change.

**Fix — a two-owner model:** the **OS supervisor keeps the worker _alive_**
(Linux `Restart=always`; Windows a 5-minute watchdog repetition trigger), and
**SessionStart keeps it _current_** (compares the hook's compiled `VERSION` to
`/stats.version` and graceful-restarts on mismatch) while also providing
bounded-blocking instant recovery when a session opens. `UserPromptSubmit` does
non-blocking fire-and-forget revival between sessions. Applied to **both** the
`captain-memo-worker` and `captain-memo-embed` services.

## 2. Decisions (locked)

| # | Decision | Choice | Why |
|---|---|---|---|
| 1 | Recovery model | **Hybrid: OS-supervisor backstop + hook self-heal** | Instant during use; durable even when Claude is closed. |
| 2 | Hook behavior | **Block on SessionStart only; `UserPromptSubmit` fire-and-forget** | Spend the ~1.5 s boot wait once per session, never on the per-prompt hot path (preserves the v0.2.13 thin/fail-open hooks). |
| 3 | Scope | **Auto-recovery + upgrade-staleness** (NOT Windows kill-prevention) | User-selected. Recovery covers *all* death causes, so it is complete on its own; kill-prevention is deferred polish. |
| 4 | Staleness detection | **Approach A: SessionStart compares `VERSION` vs `/stats.version`, graceful-restart on mismatch** | Cheap, controlled (once/session), reuses the recovery path; avoids giving the long-lived worker a self-restart loop. |
| 5 | Linux policy | **`Restart=always` + `StartLimitIntervalSec=0`** | Relaunches clean-signal kills; the disabled rate-limiter stops a flapping worker from permanently entering `failed`. |
| 6 | Windows policy | **Add a repetition trigger (`PT5M`, `IgnoreNew`) + keep `RestartOnFailure` + `LogonTrigger`** | Task Scheduler cannot "restart on Ctrl-C"; a periodic no-op-when-alive trigger is the only OS-native backstop. |
| 7 | Services covered | **Both `worker` and `embed`** | Avoids a half-dead system where the worker recovers but embedding stays down. |
| 8 | Abstraction change | **`restart: 'no' \| 'on-failure' \| 'always'` + `watchdogIntervalSec?` on `ServiceSpec`; systemd `__RESTART__` placeholder** | Single source of truth; no hardcoded `Restart=` literal. |
| 9 | Concurrency | **Advisory lockfile in `DATA_DIR` with a TTL** | One restart across N simultaneous sessions; a crashed holder's lock expires. |

## 3. Architecture — two jobs, two owners

| Job | Owner | Fires on |
|---|---|---|
| Keep worker **alive** | OS supervisor (always-on) | any death — `Ctrl-C`, `kill`, crash, OOM, reboot |
| Keep worker **current** | `SessionStart` hook | new code on disk (version mismatch) |
| Instant **revival** between sessions | `UserPromptSubmit` (fire-and-forget) | a dead worker found mid-use |

The OS supervisor owns liveness because it runs even when Claude is closed.
SessionStart owns staleness because stale code only matters the next time memory
is used. `UserPromptSubmit` only nudges a start; it never blocks and never checks
the version.

**Key simplification — staleness needs no file read.** Claude re-reads the hook
bundle (`plugin/dist/captain-memo-hook.js`) from disk on every invocation, and the
bundle has `VERSION` (← `package.json`, via `src/shared/version.ts`) compiled in.
After a plugin update the on-disk hook is the *new* version while the running
worker still reports the *old* one, so staleness is exactly
**`VERSION !== stats.version`** — the hook's own constant already *is* the on-disk
truth, with no path resolution and no race against a half-written `package.json`.

## 4. Mechanism details

### 4.1 Linux — systemd units (4 files: `worker` + `embed`, each `.service` + `.user.service`)
- `Restart=on-failure` → **`Restart=always`**; add **`StartLimitIntervalSec=0`**;
  keep `RestartSec=5`.
- Driven by a new **`__RESTART__`** placeholder substituted from
  `ServiceSpec.restart` (so the literal is not hardcoded in the template).
- **Race-safety with `upgrade`/`vacuum`:** the worker traps `SIGTERM`/`SIGINT`
  (`src/worker/index.ts:1612–1613` → `shutdown` closes the watcher, queue, stores,
  vector + meta DBs, releasing SQLite locks). `systemctl stop` is authoritative
  (systemd never auto-restarts after an explicit stop), and `RestartSec=5` cushions
  the brief `POST /shutdown` → `systemctl stop` window in `ServiceManager.stop()`.
  The `stop → VACUUM → start` dance in `upgrade.ts`/`vacuum.ts` therefore stays
  correct under `Restart=always`.

### 4.2 Windows — Scheduled Task (`src/services/service-manager/windows-scheduled-task.ts`, `buildTaskXml`)
- Add a **repetition trigger** alongside the existing `LogonTrigger`: a
  `<TimeTrigger>` with a fixed past `<StartBoundary>` and
  `<Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>`,
  `<Enabled>true</Enabled>`. With the already-present
  `MultipleInstancesPolicy=IgnoreNew`, each fire is a **no-op when alive** and a
  **relaunch when dead**.
- Keep `RestartOnFailure` (3× / 1 min) for crashes and the `LogonTrigger` for
  logon autostart. `DisallowStartIfOnBatteries=false` (already set) keeps the
  watchdog firing on battery; rely on `StartWhenAvailable` for missed fires after
  sleep.
- `buildTaskXml` reads `spec.watchdogIntervalSec` (default **300**) → `PT{n}M`/`PT{n}S`.
  (Install runs under a real Bun runtime, so building the `StartBoundary` timestamp
  is fine.)

### 4.3 ServiceManager contract (`src/services/service-manager/types.ts` + impls + call sites)
- **`ServiceSpec`:** replace `restartOnFailure: boolean` with
  `restart: 'no' | 'on-failure' | 'always'`; add `watchdogIntervalSec?: number`
  (Windows-only; systemd ignores it — `Restart=always` is continuous).
- **`install.ts` call sites:** `worker.restart = 'always'`, `embed.restart = 'always'`,
  both `watchdogIntervalSec = 300`.
- **`systemd.ts`:** substitute `__RESTART__` from `spec.restart`; emit
  `StartLimitIntervalSec=0` (template).
- **`windows-scheduled-task.ts`:** emit the repetition trigger from
  `spec.watchdogIntervalSec`.

### 4.4 SessionStart hook (`src/hooks/session-start.ts`) — "ensure healthy + current"
```
probe /stats
  reachable && VERSION === stats.version   → show stats banner (unchanged)
  unreachable                              → acquire heal-lock
                                              → ServiceManager.start(worker[, embed])
                                              → wait for /health (bounded ≈ 8 s; Claude's
                                                SessionStart hook timeout gives headroom)
                                              → re-probe → banner (or degraded on timeout)
  reachable && VERSION !== stats.version   → acquire heal-lock
                                              → ServiceManager.stop({graceful}) → start
                                              → wait /health → re-probe
                                              → banner + "updated to vX" note
```
- **Concurrency guard:** an advisory lockfile (`DATA_DIR/.worker-heal.lock`,
  `O_EXCL` create + mtime TTL ≈ 20 s). If held and fresh, skip the start/restart and
  just wait + re-probe (another session is healing). Released in a `finally`.
- The hook now needs the **ServiceManager**; import it **lazily on the
  failure/stale path only**, so the healthy happy path doesn't grow the hook's load
  cost.

### 4.5 UserPromptSubmit (`src/hooks/user-prompt-submit.ts`)
- On a worker-unreachable result from `/inject/context`, **fire**
  `ServiceManager.start()` (issue the start, do not wait for `/health`) and return
  immediately — the supervisor owns the process, so nothing is orphaned when the
  short-lived hook exits. Guarded by the same heal-lock to avoid a stampede. Never
  blocks the prompt; never checks the version.

## 5. Error handling (fail-open everywhere)
- Every self-heal path is best-effort: if `start()`/`stop()` throws (task not
  installed, no `systemctl`/`pwsh`), log via the existing `logWorkerFailure` and
  fall back to the **degraded banner** — never block the session, never crash.
- All waits are **bounded**; a stale lock expires by TTL so a crashed holder can't
  deadlock future heals.
- If a staleness restart fails, keep using the **stale-but-alive** worker (with a
  degraded note) rather than ending up with no worker.

## 6. Testing
- **Unit (cross-platform; Linux CI):** `buildTaskXml` emits the repetition trigger
  (assert `PT5M`, `IgnoreNew`, `StartBoundary`); systemd `__RESTART__` substitution
  → `Restart=always` + `StartLimitIntervalSec=0`; staleness comparator
  (`VERSION` vs `stats.version`); heal-lock acquire / TTL-expire.
- **Integration (reuse the v0.2.13 closed-port harness):** SessionStart branches
  (unreachable→start, stale→restart, healthy→probe); concurrency guard → exactly
  one restart for two simultaneous SessionStarts; `UserPromptSubmit` fire-and-forget
  adds no measurable latency.
- **Regression:** `upgrade`/`vacuum` `stop → VACUUM → start` under `Restart=always`
  takes the exclusive lock cleanly (no spurious relaunch racing the vacuum).
- All existing **483 tests** + `bun run typecheck` stay green.

## 7. File change inventory
**New:** `src/shared/worker-heal-lock.ts` (single-purpose advisory lock);
tests under `tests/unit/` + `tests/integration/`; this spec.

**Modified:**
`services/worker/systemd/captain-memo-worker.service`,
`services/worker/systemd/captain-memo-worker.user.service`,
`services/embed/systemd/captain-memo-embed.service`,
`services/embed/systemd/captain-memo-embed.user.service`,
`src/services/service-manager/types.ts`,
`src/services/service-manager/systemd.ts`,
`src/services/service-manager/windows-scheduled-task.ts`,
`src/cli/commands/install.ts` (call sites: `restart`/`watchdogIntervalSec`),
`src/hooks/session-start.ts`,
`src/hooks/user-prompt-submit.ts`,
`src/hooks/shared.ts` (shared heal helper, if extracted),
`package.json` (version 0.2.14), `CHANGELOG.md`, `README.md` (recovery note).

## 8. Risks
- **`Restart=always` + a genuinely broken worker** → with `StartLimitIntervalSec=0`
  it restarts forever (log spam) instead of giving up. Accepted: "always recovers"
  beats "silently gives up"; `RestartSec=5` spaces the attempts and
  `logWorkerFailure` + `doctor` keep it visible.
- **Hook now depends on the ServiceManager** (today the hooks import nothing capable
  of starting a process). Mitigation: dynamic-import the ServiceManager only on the
  failure/stale path; keep the happy path untouched.
- **Windows repetition trigger wakes the machine every 5 min** — minor battery cost;
  intended (recovery while Claude is closed). `StartWhenAvailable` covers
  post-sleep missed fires.
- **Graceful-stop race** is covered by design, but is guarded by an explicit
  regression test so a future change can't silently reintroduce a vacuum-vs-restart
  lock fight.
- **Staleness false-positive during a partial update** (hook newer than worker mid-
  install) → the restart simply converges the worker to the on-disk version;
  idempotent.

## 9. Acceptance criteria
1. `kill <worker-pid>` (Linux `SIGTERM`) / `Stop-ScheduledTask captain-memo-worker`
   (Windows) → the worker returns **automatically** — Linux within `RestartSec`,
   Windows within 5 min via the watchdog **or** instantly on the next Claude session.
2. Open a new Claude session with the worker down → SessionStart starts it and the
   session opens with memory **live** (stats banner, not the degraded banner).
3. Bump `package.json`, redeploy hook+worker code, leave the old worker running →
   open a session → SessionStart detects `VERSION !== stats.version`,
   graceful-restarts, and the banner shows the **new** version.
4. Two sessions opened simultaneously with the worker down → **exactly one** restart
   (lock works).
5. `UserPromptSubmit` during an outage adds no measurable latency; the worker is up
   for the next prompt.
6. `captain-memo upgrade` / `captain-memo vacuum` still complete cleanly under
   `Restart=always` (no lock fight).
7. The **embedder** recovers identically (kill `captain-memo-embed` → it returns).
8. All 483 tests + typecheck green; Linux behavior otherwise unchanged.

## 10. Deferred
- **Approach B** (worker self-watches `package.json` and self-exits) for code
  refresh while Claude is fully closed.
- **Windows kill-prevention** (launch the worker fully detached / windowless so a
  console-close `0xC000013A` can't reach it) — attacks the root cause so recovery
  becomes a rarer backstop.
- **macOS launchd** parity (`KeepAlive=true` is the always-on analogue; the
  `ServiceManager` abstraction is ready for it).
