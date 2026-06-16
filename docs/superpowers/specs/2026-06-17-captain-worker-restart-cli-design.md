# `captain-memo restart` — worker restart CLI command

Date: 2026-06-17
Status: approved (design + scope)

## Problem

There is no first-class way to tell a captain to restart its own worker. A restart is
needed after editing config that is read only at boot, and as a clean recovery primitive.
When triggered remotely through a federation co-session it has been fragile: a hand-authored
PowerShell relauncher relayed as free text hit three failure modes in the field (an
`AskUserQuestion` hang in headless mode, a here-string quoting bug, and a — correct —
refusal by the remote agent to execute an opaque base64 payload). A restart should be **one
named, transparent, reviewable command**.

## Editions / layering (scope decision)

The work splits along the OSS/federation line, and both halves ship:

- **OSS core (branch `master`)** — the `captain-memo restart` command with a **synchronous**
  restart. This is correct for OSS, where a restart is invoked from a terminal (no
  co-sessions exist). It uses only primitives already on `master`
  (`restartWorker` → `getServiceManager().restart()`). Inherited by `federation` via the
  normal `master → federation` merge.
- **Federation enhancement (branch `federation`)** — replace the Windows path with a
  **detached WMI relauncher**, so a restart invoked from *inside* the worker's process tree
  (a co-session / hook) is robust. Both the relauncher primitive and that invocation
  scenario are federation-only, which is why this layer lives on `federation`.

Rationale (verified against both checkouts): `buildSelfRelaunchScript`,
`scheduleWindowsSelfRestart`, and the WMI `Win32_Process.Create` relauncher are
**federation-only**; `master` has `restartWorker`, `getServiceManager().restart()`,
`buildReclaimPortCommand`, `/shutdown`, and the health probe. On Windows
`ServiceManager.restart()` is `stop(force)` then `start()` run in-process — fine when the
caller is outside the worker's task tree (operator terminal), but it strands the worker when
the caller is inside it (a co-session), because `Stop-ScheduledTask` kills the caller before
`start()`. Hence the federation layer.

Non-goal (separate future spec): an owner-signed federation `restart` RPC + cockpit
"Restart worker" button, built on top of this command.

## Command surface

```
captain-memo restart [--force]
```

- Default: graceful — `restartWorker(..., { graceful: true })` POSTs `/shutdown` first so
  SQLite drains, then restarts.
- `--force`: skip the graceful drain (hard stop → start). For a wedged/zombie worker.
- Registered in `src/cli/index.ts` dispatch + the `HELP` text, alongside `status`/`doctor`.
- Returns `0` when the worker comes back healthy; `1` when it restarted but did not report
  healthy within the bounded window (operator should check `captain-memo status`).

## Phase 1 — OSS core (branch `master`)

`restartCommand` is **platform-agnostic**: it calls `restartWorker(sm, WORKER_SERVICE,
{ port, graceful })` on every OS. `restartWorker` already dispatches per-platform inside
`getServiceManager().restart()` (systemd `restart` on Linux; Stop+Start the Scheduled Task
on Windows). After the restart it polls `/health` (bounded ~8s) and reports.

**Component:** `src/cli/commands/restart.ts` → `restartCommand(args, deps?)`.
- `WORKER_SERVICE = 'captain-memo-worker'`; port =
  `process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT`.
- Deps injected for testability: `{ sm?, port?, probe?, sleep? }` — so tests spawn nothing
  and never really wait.
- Wire into `src/cli/index.ts`: `import { restartCommand }`, `case 'restart':`, and a
  `HELP` line.

**Tests (`src/cli/commands/restart.test.ts`):**
- default → calls `sm.restart('captain-memo-worker', { graceful: true, port, force: true })`
  (via `restartWorker`); returns 0 when `probe` resolves true.
- `--force` → `graceful: false`.
- probe never healthy → returns 1 (use an injected `sleep` that resolves immediately and a
  `probe` that always returns false, with a low iteration count via injected clock or a
  small bounded loop).

## Phase 2 — federation enhancement (branch `federation`)

After Phase 1 merges to `master` and `master` merges to `federation`, layer the detached
Windows path. **Purely additive** to existing functions (federation already diverged ~110
lines in `windows-scheduled-task.ts`; we do NOT refactor/extract the shared WMI launcher, to
keep the merge clean — a few duplicated lines is the right trade here).

**Components:**
1. `buildRestartScript(name, port, { graceful })` in
   `src/services/service-manager/windows-scheduled-task.ts` — pure string builder, sibling
   to `buildSelfRelaunchScript`. Validates port (1–65535, throws like its sibling). Emits, in
   order: (graceful) a `POST /shutdown` + wait-for-port-free; then `Stop-ScheduledTask`; then
   the existing `bun`-guarded port-free loop shape (mirror `buildReclaimPortCommand`); then a
   `Start-ScheduledTask` retry-until-listening loop; logging to `~/.captain-memo/relaunch.log`.
2. `scheduleWindowsRestart(name, port, opts)` — mirror of `scheduleWindowsSelfRestart` but
   builds via `buildRestartScript`. Reuses the same WMI `Win32_Process.Create` launch shape
   (UTF-16LE base64 + `Invoke-CimMethod` + non-zero ReturnValue → throw).
3. Override the Windows branch of `restartCommand` (federation copy of `restart.ts`):
   `if (isWindows) await scheduleWindowsRestart(WORKER_SERVICE, port, { graceful }); else
   await restartWorker(...)`. The health poll afterward is best-effort (the caller may be
   killed when the relauncher stops the task — acceptable for the async path).

**Tests:**
- `buildRestartScript`: contains `Stop-ScheduledTask`, the `bun`-guarded port-free loop, and
  `Start-ScheduledTask`; graceful ⇒ includes the `/shutdown` POST, `--force` ⇒ does not;
  invalid port throws.
- `scheduleWindowsRestart`: with the WMI launcher injected/stubbed, asserts it builds via
  `buildRestartScript` and invokes the launcher once; non-zero result → throws.
- `restart.ts` Windows dispatch: injected platform=win32 → calls `scheduleWindowsRestart`;
  linux → `restartWorker`.

## Error handling

- No supervisor / no `pwsh` (federation Windows path) → actionable throw (matches
  `scheduleWindowsSelfRestart`).
- WMI `ReturnValue != 0` → throw; never report success.
- Health poll timeout → exit non-zero on Linux (synchronous, should be healthy); on the
  federation async Windows path, exit 0 with "restart armed; not yet confirmed".
- Live sessions: an explicit `restart` is operator intent → **proceed/force** (unlike
  auto-update, which defers). A `--if-idle` flag is YAGNI for v1.

## Rollout

Phase 1 ships in the next OSS (`master`) release and, via merge, the next `federation` tag.
Phase 2 ships in a subsequent `federation` tag. The fleet (track=tag on `federation`) picks
both up through auto-update. Today's manual restarts already used the relauncher; this
removes that friction permanently.
