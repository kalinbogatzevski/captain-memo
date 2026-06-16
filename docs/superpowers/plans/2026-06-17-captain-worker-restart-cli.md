# `captain-memo restart` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a transparent `captain-memo restart [--force]` command that restarts the local worker, robust on both Linux and Windows.

**Architecture:** Two layers. **Phase 1 (OSS, `master`):** a platform-agnostic command that calls `restartWorker` (→ `getServiceManager().restart()` = systemd restart / Windows Stop+Start), then health-polls. **Phase 2 (`federation`):** override the Windows path with a detached WMI relauncher so a restart invoked from inside the worker's process tree (a co-session) survives.

**Tech Stack:** Bun, TypeScript, `bun:test`. Existing primitives: `restartWorker` (`src/shared/worker-control.ts`), `getServiceManager` / `ServiceManager`, `probeHealthOnce` (`src/shared/worker-health-probe.ts`), `buildReclaimPortCommand` / `buildSelfRelaunchScript` / `scheduleWindowsSelfRestart` (`src/services/service-manager/windows-scheduled-task.ts`, the last two federation-only).

---

## File structure

- `src/cli/commands/restart.ts` — the command (Phase 1; Windows branch added in Phase 2 on `federation`).
- `src/cli/commands/restart.test.ts` — command tests.
- `src/cli/index.ts` — dispatch + HELP (Phase 1).
- `src/services/service-manager/windows-scheduled-task.ts` — `buildRestartScript` + `scheduleWindowsRestart` (Phase 2, federation).
- `src/services/service-manager/windows-scheduled-task-restart.test.ts` — Phase 2 tests.

---

## PHASE 1 — OSS core (branch `feat/worker-restart-cli` off `master`)

### Task 1: `restartCommand`

**Files:**
- Create: `src/cli/commands/restart.ts`
- Test: `src/cli/commands/restart.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/cli/commands/restart.test.ts
import { test, expect } from 'bun:test';
import { restartCommand } from './restart.ts';
import type { ServiceManager } from '../../services/service-manager/types.ts';

function fakeSm() {
  const calls: Array<{ name: string; opts: unknown }> = [];
  const sm = {
    restart: async (name: string, opts: unknown) => { calls.push({ name, opts }); },
  } as unknown as ServiceManager;
  return { sm, calls };
}

test('default restart -> restartWorker with graceful=true, force=true; healthy -> 0', async () => {
  const { sm, calls } = fakeSm();
  const code = await restartCommand([], { sm, port: 39888, probe: async () => true, sleep: async () => {}, now: () => 0 });
  expect(code).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.name).toBe('captain-memo-worker');
  expect(calls[0]!.opts).toEqual({ graceful: true, port: 39888, force: true });
});

test('--force -> graceful=false', async () => {
  const { sm, calls } = fakeSm();
  const code = await restartCommand(['--force'], { sm, port: 39888, probe: async () => true, sleep: async () => {}, now: () => 0 });
  expect(code).toBe(0);
  expect(calls[0]!.opts).toEqual({ graceful: false, port: 39888, force: true });
});

test('never healthy -> returns 1', async () => {
  const { sm } = fakeSm();
  let t = 0;
  const code = await restartCommand([], { sm, port: 39888, probe: async () => false, sleep: async () => {}, now: () => { t += 5000; return t; } });
  expect(code).toBe(1);
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd /home/kalin/projects/captain-memo-fed-wt-restart && bun test src/cli/commands/restart.test.ts`
Expected: FAIL — `Cannot find module './restart.ts'`.

- [ ] **Step 3: Implement `restart.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `bun test src/cli/commands/restart.test.ts`
Expected: PASS (3 pass).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck` (or `bunx tsc --noEmit` if no script). Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/restart.ts src/cli/commands/restart.test.ts
git commit -m "feat(cli): add captain-memo restart command (OSS core)"
```

### Task 2: Wire into the CLI dispatch + HELP

**Files:**
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Add the import** (top of `src/cli/index.ts`, with the other command imports)

```ts
import { restartCommand } from './commands/restart.ts';
```

- [ ] **Step 2: Add the dispatch case** (in the `switch (cmd)` in `main()`, next to `case 'status':`)

```ts
    case 'restart':
      exit = await restartCommand(args.slice(1));
      break;
```

- [ ] **Step 3: Add a HELP line** (in the `HELP` template string, near `status`/`doctor`)

```
  restart      Restart the local worker (reload config / recover). --force to hard-stop
```

- [ ] **Step 4: Verify the command is wired**

Run: `bun src/cli/index.ts help | grep -i restart`
Expected: the new HELP line prints.
Run: `bun run typecheck`
Expected: clean.

(Optional real smoke on this Linux dev box — restarts the local worker via systemd:
`bun src/cli/index.ts restart` → expect "✓ worker is healthy". Skip if you don't want to bounce the dev worker.)

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): wire restart into dispatch + help"
```

**Phase 1 done.** This is shippable OSS on its own. Merge `feat/worker-restart-cli` → `master`, then merge `master` → `federation` before Phase 2.

---

## PHASE 2 — federation enhancement (branch off `federation`, after Phase 1 is merged in)

> Purely additive to `windows-scheduled-task.ts` — do NOT refactor/extract the existing WMI launcher (federation diverged ~110 lines there; additive keeps merges clean). A few duplicated lines is the intended trade.

### Task 3: `buildRestartScript` (pure builder)

**Files:**
- Modify: `src/services/service-manager/windows-scheduled-task.ts` (add the export)
- Test: `src/services/service-manager/windows-scheduled-task-restart.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/services/service-manager/windows-scheduled-task-restart.test.ts
import { test, expect } from 'bun:test';
import { buildRestartScript } from './windows-scheduled-task.ts';

test('buildRestartScript: stop + bun port-free loop + start', () => {
  const s = buildRestartScript('captain-memo-worker', 39888, { graceful: false });
  expect(s).toContain("Stop-ScheduledTask -TaskName 'captain-memo-worker'");
  expect(s).toContain("Start-ScheduledTask -TaskName 'captain-memo-worker'");
  expect(s).toContain("ProcessName -eq 'bun'");
});

test('buildRestartScript: graceful includes /shutdown; force does not', () => {
  expect(buildRestartScript('w', 39888, { graceful: true })).toContain('/shutdown');
  expect(buildRestartScript('w', 39888, { graceful: false })).not.toContain('/shutdown');
});

test('buildRestartScript: invalid port throws', () => {
  expect(() => buildRestartScript('w', 0, { graceful: true })).toThrow();
  expect(() => buildRestartScript('w', 70000, { graceful: false })).toThrow();
});
```

- [ ] **Step 2: Run, verify fail**

Run: `bun test src/services/service-manager/windows-scheduled-task-restart.test.ts`
Expected: FAIL — `buildRestartScript` not exported.

- [ ] **Step 3: Implement `buildRestartScript`** (add near `buildSelfRelaunchScript` in `windows-scheduled-task.ts`; uses the existing module-local `psSingleQuote`)

```ts
/** PowerShell a DETACHED relauncher runs to restart the worker on EXTERNAL trigger
 *  (a CLI/co-session/hook restart — unlike buildSelfRelaunchScript, the worker is NOT
 *  exiting on its own, so this STOPS the task itself). Pure/unit-testable. */
export function buildRestartScript(
  name: string,
  port: number,
  opts: { graceful: boolean },
  freeTimeoutMs = 20_000,
  startTimeoutMs = 40_000,
): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`buildRestartScript: invalid port ${port} (expected integer 1-65535)`);
  }
  const qName = psSingleQuote(name);
  const freeMs = Math.max(0, Math.floor(freeTimeoutMs));
  const startMs = Math.max(0, Math.floor(startTimeoutMs));
  const lines: string[] = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `$log="$env:USERPROFILE\\.captain-memo\\relaunch.log"`,
    `function L($m){ "$([DateTime]::Now.ToString('o')) $m" | Out-File -FilePath $log -Append -Encoding utf8 }`,
    `L "restart start ${name} :${port} graceful=${opts.graceful}"`,
  ];
  if (opts.graceful) {
    lines.push(
      `try { Invoke-WebRequest -UseBasicParsing -Method POST -Uri "http://127.0.0.1:${port}/shutdown" -TimeoutSec 3 | Out-Null } catch {}`,
      `$g=(Get-Date).AddMilliseconds(8000)`,
      `do { if (@(Get-NetTCPConnection -LocalPort ${port} -State Listen).Count -eq 0) { break }; Start-Sleep -Milliseconds 250 } while ((Get-Date) -lt $g)`,
    );
  }
  lines.push(
    `Stop-ScheduledTask -TaskName ${qName}`,
    `$free=(Get-Date).AddMilliseconds(${freeMs})`,
    `do {`,
    `  $owners=@(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)`,
    `  if ($owners.Count -eq 0) { break }`,
    `  foreach ($ownerPid in $owners) {`,
    `    $proc=Get-Process -Id $ownerPid -ErrorAction SilentlyContinue`,
    `    if ($proc -and $proc.ProcessName -eq 'bun') { Stop-Process -Id $ownerPid -Force }`,
    `  }`,
    `  Start-Sleep -Milliseconds 200`,
    `} while ((Get-Date) -lt $free)`,
    `Start-Sleep -Milliseconds 600`,
    `$deadline=(Get-Date).AddMilliseconds(${startMs})`,
    `do { Start-ScheduledTask -TaskName ${qName}; Start-Sleep -Milliseconds 800; if (@(Get-NetTCPConnection -LocalPort ${port} -State Listen).Count -gt 0) { break } } while ((Get-Date) -lt $deadline)`,
    `L "restart done listening=$(@(Get-NetTCPConnection -LocalPort ${port} -State Listen).Count)"`,
  );
  return lines.join('\n');
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/services/service-manager/windows-scheduled-task-restart.test.ts`
Expected: PASS (3 pass).

- [ ] **Step 5: Commit**

```bash
git add src/services/service-manager/windows-scheduled-task.ts src/services/service-manager/windows-scheduled-task-restart.test.ts
git commit -m "feat(fed): buildRestartScript — detached restart relauncher (pure builder)"
```

### Task 4: `scheduleWindowsRestart` (detached WMI launch)

**Files:**
- Modify: `src/services/service-manager/windows-scheduled-task.ts`
- Test: append to `windows-scheduled-task-restart.test.ts`

- [ ] **Step 1: Write the failing tests** (append)

```ts
import { scheduleWindowsRestart } from './windows-scheduled-task.ts';

test('scheduleWindowsRestart: encodes buildRestartScript + launches once', async () => {
  let captured = '';
  await scheduleWindowsRestart('captain-memo-worker', 39888, { graceful: true }, {
    findShell: () => 'pwsh',
    launch: async (cmd: string) => { captured = cmd; return 0; },
  });
  expect(captured).toContain('-EncodedCommand');
  const b64 = captured.split('-EncodedCommand ')[1]!.trim();
  expect(Buffer.from(b64, 'base64').toString('utf16le')).toContain('Stop-ScheduledTask');
});

test('scheduleWindowsRestart: no shell -> throws', async () => {
  await expect(scheduleWindowsRestart('w', 39888, { graceful: true }, { findShell: () => null, launch: async () => 0 }))
    .rejects.toThrow(/no pwsh/);
});

test('scheduleWindowsRestart: non-zero launch -> throws', async () => {
  await expect(scheduleWindowsRestart('w', 39888, { graceful: true }, { findShell: () => 'pwsh', launch: async () => 1 }))
    .rejects.toThrow(/failed/);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `bun test src/services/service-manager/windows-scheduled-task-restart.test.ts`
Expected: FAIL — `scheduleWindowsRestart` not exported.

- [ ] **Step 3: Implement** (add to `windows-scheduled-task.ts`; the default `launch` duplicates the ~6-line WMI launch from `scheduleWindowsSelfRestart` deliberately — additive, no edit to that function)

```ts
/** Default detached launcher: create the relauncher OUT of our process job via WMI
 *  Win32_Process.Create (survives the caller's exit/kill). Duplicated from
 *  scheduleWindowsSelfRestart on purpose — kept additive so the master→federation
 *  merge never conflicts on that function. */
async function launchRestartViaWmi(childCmd: string): Promise<number> {
  const shell = Bun.which('pwsh') ?? Bun.which('powershell');
  if (!shell) throw new Error('launchRestartViaWmi: no pwsh/powershell found on PATH');
  const launcher = [
    `$ErrorActionPreference='Stop'`,
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psSingleQuote(childCmd)} }`,
    `if ($null -eq $r -or $r.ReturnValue -ne 0) { exit 1 }`,
    `exit 0`,
  ].join('\n');
  const launcherB64 = Buffer.from(launcher, 'utf16le').toString('base64');
  const child = Bun.spawn([shell, '-NoProfile', '-NonInteractive', '-EncodedCommand', launcherB64], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  return await child.exited;
}

/** External-trigger restart: arm a detached relauncher that stops+starts the worker
 *  task, then return. Robust when the caller is inside the worker's process tree (a
 *  co-session/hook) — the WMI-created relauncher survives the caller's death. */
export async function scheduleWindowsRestart(
  name: string,
  port: number,
  opts: { graceful: boolean },
  deps: { findShell?: () => string | null; launch?: (childCmd: string) => Promise<number> } = {},
): Promise<void> {
  const findShell = deps.findShell ?? (() => Bun.which('pwsh') ?? Bun.which('powershell'));
  const launch = deps.launch ?? launchRestartViaWmi;
  const shell = findShell();
  if (!shell) throw new Error('scheduleWindowsRestart: no pwsh/powershell found on PATH');
  const b64 = Buffer.from(buildRestartScript(name, port, opts), 'utf16le').toString('base64');
  const childCmd = `"${shell}" -NoProfile -NonInteractive -EncodedCommand ${b64}`;
  const code = await launch(childCmd);
  if (code !== 0) throw new Error(`scheduleWindowsRestart: WMI relauncher launch failed (exit ${code})`);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/services/service-manager/windows-scheduled-task-restart.test.ts`
Expected: PASS (6 pass total).

- [ ] **Step 5: Commit**

```bash
git add src/services/service-manager/windows-scheduled-task.ts src/services/service-manager/windows-scheduled-task-restart.test.ts
git commit -m "feat(fed): scheduleWindowsRestart — detached WMI relauncher for external restart"
```

### Task 5: Use the detached path on Windows in `restartCommand` (federation copy)

**Files:**
- Modify: `src/cli/commands/restart.ts`
- Test: append to `src/cli/commands/restart.test.ts`

- [ ] **Step 1: Write the failing tests** (append)

```ts
test('win32 -> scheduleWindowsRestart (not restartWorker)', async () => {
  const { sm, calls } = fakeSm();
  let armed: { name: string; port: number; graceful: boolean } | null = null;
  const code = await restartCommand([], {
    sm, port: 39888, platform: 'win32',
    scheduleWindows: async (name, port, opts) => { armed = { name, port, graceful: opts.graceful }; },
    probe: async () => true, sleep: async () => {}, now: () => 0,
  });
  expect(code).toBe(0);
  expect(calls).toHaveLength(0); // restartWorker NOT used on win32
  expect(armed).toEqual({ name: 'captain-memo-worker', port: 39888, graceful: true });
});

test('linux -> restartWorker (not scheduleWindowsRestart)', async () => {
  const { sm, calls } = fakeSm();
  let armed = false;
  const code = await restartCommand([], {
    sm, port: 39888, platform: 'linux',
    scheduleWindows: async () => { armed = true; },
    probe: async () => true, sleep: async () => {}, now: () => 0,
  });
  expect(code).toBe(0);
  expect(armed).toBe(false);
  expect(calls).toHaveLength(1);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `bun test src/cli/commands/restart.test.ts`
Expected: FAIL — `platform`/`scheduleWindows` not on `RestartDeps`; win32 path missing.

- [ ] **Step 3: Implement** (extend `RestartDeps` + branch in `restart.ts`)

Add to `RestartDeps`:
```ts
  platform?: string;
  scheduleWindows?: (name: string, port: number, opts: { graceful: boolean }) => Promise<void>;
```
Add the import:
```ts
import { scheduleWindowsRestart } from '../../services/service-manager/windows-scheduled-task.ts';
```
Replace the single `await restartWorker(...)` line with:
```ts
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    await (deps.scheduleWindows ?? scheduleWindowsRestart)(WORKER_SERVICE, port, { graceful });
  } else {
    await restartWorker(sm, WORKER_SERVICE, { port, graceful });
  }
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/cli/commands/restart.test.ts`
Expected: PASS (5 pass — the 3 from Phase 1 still green: they pass `platform: undefined` → defaults to the host, which on the Linux CI/dev box is `linux` → `restartWorker`; if running tests on Windows, add `platform: 'linux'` to those three to keep them deterministic).

- [ ] **Step 5: Typecheck + full suite**

Run: `bun run typecheck && bun test src/cli/ src/services/service-manager/`
Expected: clean + green.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/restart.ts src/cli/commands/restart.test.ts
git commit -m "feat(fed): restart uses detached WMI relauncher on Windows"
```

**Phase 2 done.** Release a new `federation` tag so the fleet auto-updates.

---

## Self-review notes (author)

- **Spec coverage:** command surface (Task 1–2), graceful/--force (Task 1), Linux path (Task 1), Windows OSS sync (Task 1 via restartWorker), federation detached path (Tasks 3–5), error handling (Task 1 health-poll exit, Task 4 throws), tests per layer (all tasks). Covered.
- **Determinism:** the Phase-1 tests pass `now`/`sleep`/`probe` so nothing waits or spawns; the Phase-1 `platform: undefined` default resolves to the host — note in Task 5 Step 4 about pinning `platform: 'linux'` if the suite ever runs on Windows.
- **Type consistency:** `WORKER_SERVICE = 'captain-memo-worker'` everywhere; `{ graceful }` opts shape consistent across `restartCommand` → `scheduleWindowsRestart` → `buildRestartScript`; `restartWorker(sm, name, {port, graceful})` matches its real signature (it adds `force:true` internally).
- **No placeholders.**
