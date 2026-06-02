// src/services/service-manager/windows-scheduled-task.ts — Windows ServiceManager
// over per-user Scheduled Tasks (PowerShell ScheduledTasks module).
//
// Design (spec §4.1): no admin / no UAC. Registration goes through
// `schtasks /Create /XML` (Task Scheduler 1.2 XML) rather than
// Register-ScheduledTask — on Win11 the cmdlet trips a UAC/admin requirement,
// whereas schtasks /XML registers a per-user task non-elevated (verified in the
// field). The XML pins LogonType=InteractiveToken + RunLevel=LeastPrivilege (the
// current user's normal token, no elevation), a LogonTrigger, and (when
// restartOnFailure) restart up to 3× at 1-minute intervals with no execution
// time limit — the closest Scheduled-Task analogue to the rootless
// `systemd --user` + Restart=on-failure the Linux impl provides.
//
// start/stop/status/isActive/remove still use the ScheduledTasks cmdlets
// (Start-/Stop-/Get-/Unregister-ScheduledTask), which need no admin and operate
// fine on a schtasks-created task — Unregister-ScheduledTask cleans it up. We
// prefer `pwsh` (PowerShell 7+) and fall back to the in-box `powershell`
// (Windows PowerShell 5.1); both expose the cmdlets used here.
//
// LIVENESS: status()/isActive() report the Scheduled-Task State, but that only
// says whether the task's *process* is running — not whether the worker's HTTP
// server is actually serving. `doctor` therefore treats the HTTP /health probe as
// the authoritative liveness check (see src/cli/commands/doctor.ts); this State
// mapping is the best-effort supervisor view.
//
// LOGGING: there is no journal on Windows. The task action runs `bun` directly,
// and the worker itself writes its own log file into spec.logDir. We deliberately
// do NOT redirect stdout/stderr from the task here — worker-side logging owns that.

import { writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ServiceManager, ServiceSpec, ServiceState, StopOptions } from './types.ts';
import { DEFAULT_WORKER_PORT } from '../../shared/paths.ts';

// --- PowerShell quoting -----------------------------------------------------
// PowerShell single-quoted strings are literal; the only escape is a doubled
// single-quote. Wrapping every interpolated path/value in single quotes keeps
// paths-with-spaces intact without any shell word-splitting. We NEVER concatenate
// raw values into the command — every dynamic value goes through this.
function psSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// --- XML escaping -----------------------------------------------------------
// Every value interpolated into the Task Scheduler XML (paths, names,
// arguments) must be escaped so a path/value containing &, <, >, ", or ' can't
// break the document or smuggle markup. We escape the full set rather than the
// minimal element/attribute subset — it's always valid in both contexts and
// leaves no room to get it wrong.
function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

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

// Build the <Arguments> value for the Exec action: everything in spec.exec
// after the executable (exec[0]), joined as a single command-line string. Each
// token is double-quoted so a token containing spaces survives the round-trip
// into the task's argument string. The whole thing is XML-escaped by the caller
// before it lands in the document.
function buildArgumentString(exec: string[]): string {
  return exec
    .slice(1)
    .map((tok) => (/\s/.test(tok) ? `"${tok}"` : tok))
    .join(' ');
}

/**
 * Pure builder for the Task Scheduler 1.2 XML that `schtasks /Create /XML`
 * registers. Exported so the construction can be unit-tested WITHOUT spawning
 * schtasks (the test runs on Linux CI). The returned string is written to a
 * temp file and passed to `schtasks /Create /TN <name> /XML <tmpfile> /F`.
 *
 * Why schtasks /XML rather than Register-ScheduledTask: on Win11 the latter
 * trips a UAC/admin requirement, whereas `schtasks /Create … /XML` is verified
 * to register a per-user task non-elevated in the field.
 *
 * The XML encodes (spec §4.1, rootless / no-admin):
 *   - LogonTrigger                          → autostart at this user's logon
 *   - Principal LogonType=InteractiveToken
 *     RunLevel=LeastPrivilege               → current user's normal token, no UAC
 *   - Settings (when restartOnFailure):
 *       RestartCount=3, RestartInterval=PT1M,
 *       MultipleInstancesPolicy=IgnoreNew,
 *       ExecutionTimeLimit=PT0S             → restart up to 3× at 1-min, run forever
 *   - Actions/Exec: Command=exec[0],
 *       Arguments=quoted exec[1..],
 *       WorkingDirectory=workingDir
 */
export function buildTaskXml(spec: ServiceSpec): string {
  const exe = spec.exec[0] ?? 'bun';
  const argString = buildArgumentString(spec.exec);

  const settings = spec.restartOnFailure
    ? [
        '  <Settings>',
        '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
        '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
        '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
        '    <AllowHardTerminate>true</AllowHardTerminate>',
        '    <StartWhenAvailable>true</StartWhenAvailable>',
        '    <Enabled>true</Enabled>',
        '    <RestartOnFailure>',
        '      <Interval>PT1M</Interval>',
        '      <Count>3</Count>',
        '    </RestartOnFailure>',
        '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
        '  </Settings>',
      ]
    : [
        '  <Settings>',
        '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
        '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
        '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
        '    <StartWhenAvailable>true</StartWhenAvailable>',
        '    <Enabled>true</Enabled>',
        '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
        '  </Settings>',
      ];

  // Arguments is optional: only emit it when there actually are arguments, so a
  // bare executable doesn't get an empty <Arguments/> element.
  const execLines = [
    '    <Exec>',
    `      <Command>${xmlEscape(exe)}</Command>`,
  ];
  if (argString.length > 0) execLines.push(`      <Arguments>${xmlEscape(argString)}</Arguments>`);
  execLines.push(`      <WorkingDirectory>${xmlEscape(spec.workingDir)}</WorkingDirectory>`);
  execLines.push('    </Exec>');

  // Scope the task to the current user. WITHOUT <UserId>, schtasks /Create can't
  // bind the task to the logged-on user and falls back to a registration that
  // needs an elevated token → "Access is denied" for a normal user (field-verified).
  const userId = xmlEscape(
    `${process.env.USERDOMAIN ?? process.env.COMPUTERNAME ?? ''}\\${process.env.USERNAME ?? ''}`,
  );
  // Periodic watchdog: a TimeTrigger with an indefinite <Repetition> re-launches
  // the task every interval. With MultipleInstancesPolicy=IgnoreNew it is a no-op
  // when the worker is alive and a relaunch when it is dead — the only OS-native
  // way to recover a clean-killed task (STATUS_CONTROL_C_EXIT) that
  // RestartOnFailure does not count as a failure.
  const watchdogInterval = isoDuration(spec.watchdogIntervalSec ?? 300);
  const lines = [
    // schtasks /Create /XML requires UTF-16 LE + BOM (the native Task Scheduler
    // format — UTF-8 is rejected with "unable to switch the encoding"). install()
    // writes the file that way via toTaskXmlBuffer(); the declaration must match.
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${xmlEscape(spec.description)}</Description>`,
    `    <URI>\\${xmlEscape(spec.name)}</URI>`,
    '  </RegistrationInfo>',
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
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${userId}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    ...settings,
    '  <Actions Context="Author">',
    ...execLines,
    '  </Actions>',
    '</Task>',
  ];
  return lines.join('\n');
}

// --- PowerShell process plumbing -------------------------------------------
// All argv is built as an ARRAY (never string concat) so paths with spaces in
// the -Command payload survive. The PowerShell command text itself is one argv
// element; PowerShell parses it internally.
const PS_PREFIX_ARGS = ['-NoProfile', '-NonInteractive', '-Command'] as const;

// Try pwsh first, fall back to powershell. Result of whichever ran.
async function runPowerShell(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  for (const shell of ['pwsh', 'powershell']) {
    try {
      const proc = Bun.spawn([shell, ...PS_PREFIX_ARGS, command], {
        stdout: 'pipe',
        stderr: 'pipe',
        // Never flash a console window for these background status/management calls
        // (status/start/stop/reclaim run from the worker, the watchdog, and hooks).
        windowsHide: true,
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      return { exitCode, stdout, stderr };
    } catch {
      // shell not on PATH — try the next one
      continue;
    }
  }
  throw new Error('neither pwsh nor powershell is available on PATH');
}

// --- schtasks process plumbing ---------------------------------------------
// Registration goes through `schtasks /Create … /XML`, NOT
// Register-ScheduledTask: on Win11 the cmdlet trips a UAC/admin requirement,
// while schtasks /XML registers a per-user task non-elevated (verified in the
// field). argv is an ARRAY (never string concat) so the temp-file path with
// spaces survives. /F overwrites an existing task (idempotent reinstall).
async function runSchtasks(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['schtasks', ...args], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

// Build the PowerShell that hard-kills a ZOMBIE worker: any `bun` process still
// LISTENING on `port`. This is the reliable kill — Stop-ScheduledTask asks the
// scheduler to end the task but does NOT always terminate a detached worker
// process (field-verified 2026-06-01: a zombie survived Stop-ScheduledTask and
// held the task "Running", so IgnoreNew no-op'd every restart for ~2.7h).
//
// Exported so the command text is unit-testable without spawning PowerShell.
// Safety: the `bun`-name guard means an unrelated process that happens to own the
// port is left alone. Bounded poll so the caller's subsequent start() never races
// a still-bound port. NB: NEVER name a loop var `$pid` — that is a PowerShell
// AUTOMATIC variable (this very process's PID); we use `$ownerPid`.
export function buildReclaimPortCommand(port: number, timeoutMs = 5000): string {
  // Defensive: a garbage CAPTAIN_MEMO_WORKER_PORT (NaN / out of range) would
  // otherwise emit `-LocalPort NaN` and silently match nothing. Fail loud — the
  // caller (stop with force) swallows it, so a bad port skips the reclaim rather
  // than running a malformed command that "succeeds" while killing nothing.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`buildReclaimPortCommand: invalid port ${port} (expected integer 1-65535)`);
  }
  const deadlineMs = Math.max(0, Math.floor(timeoutMs));
  return [
    `$ErrorActionPreference='SilentlyContinue'`,
    `$deadline=(Get-Date).AddMilliseconds(${deadlineMs})`,
    `do {`,
    `  $owners=@(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)`,
    `  if ($owners.Count -eq 0) { break }`,
    `  foreach ($ownerPid in $owners) {`,
    `    $proc=Get-Process -Id $ownerPid -ErrorAction SilentlyContinue`,
    // Exact 'bun' (Get-Process strips the .exe) — tighter than a 'bun*' prefix so a
    // stray process like 'bunny.exe' can never be caught, even on the worker port.
    `    if ($proc -and $proc.ProcessName -eq 'bun') { Stop-Process -Id $ownerPid -Force }`,
    `  }`,
    `  Start-Sleep -Milliseconds 200`,
    `} while ((Get-Date) -lt $deadline)`,
  ].join('\n');
}

// schtasks /Create /XML rejects UTF-8 ("unable to switch the encoding") — it
// requires UTF-16 LE with a BOM. Encode the document accordingly. Exported so the
// encoding is unit-testable (assert the FF FE BOM) without invoking schtasks.
export function toTaskXmlBuffer(xml: string): Buffer {
  return Buffer.from('﻿' + xml, 'utf16le');
}

class WindowsScheduledTaskServiceManager implements ServiceManager {
  async install(spec: ServiceSpec): Promise<void> {
    const xml = buildTaskXml(spec);
    // Write the spec to a temp file and hand it to schtasks /XML. We do NOT pipe
    // it on stdin — schtasks only reads the XML from a path.
    const xmlPath = join(tmpdir(), `captain-memo-task-${spec.name}-${process.pid}-${Date.now()}.xml`);
    writeFileSync(xmlPath, toTaskXmlBuffer(xml));
    try {
      const r = await runSchtasks(['/Create', '/TN', spec.name, '/XML', xmlPath, '/F']);
      if (r.exitCode !== 0) {
        throw new Error(
          `schtasks /Create failed for ${spec.name}: ${r.stderr.trim() || r.stdout.trim()}`,
        );
      }
    } finally {
      // Best-effort cleanup of the temp file regardless of success/failure.
      try {
        rmSync(xmlPath, { force: true });
      } catch {
        // ignore — temp dir cleanup is not load-bearing
      }
    }
  }

  async remove(name: string): Promise<void> {
    // -Confirm:$false so it doesn't block on a prompt; -ErrorAction
    // SilentlyContinue so removing a not-installed task is a no-op (idempotent
    // uninstall, matching the systemd impl's stop/disable on a missing unit).
    await runPowerShell(
      `Unregister-ScheduledTask -TaskName ${psSingleQuote(name)} -Confirm:$false -ErrorAction SilentlyContinue`,
    );
  }

  async start(name: string): Promise<void> {
    // Throw on a non-zero exit so the self-heal orchestrator's `failed` branch
    // fires and the PowerShell error reaches hook.log (mirrors install()'s check).
    const r = await runPowerShell(`Start-ScheduledTask -TaskName ${psSingleQuote(name)}`);
    if (r.exitCode !== 0) {
      throw new Error(`Start-ScheduledTask ${name} failed (exit ${r.exitCode}): ${r.stderr.trim() || 'no stderr'}`);
    }
  }

  async stop(name: string, opts?: StopOptions): Promise<void> {
    if (opts?.graceful) {
      // POST /shutdown first so the worker drains + releases SQLite locks before
      // the task is force-stopped. Best-effort + bounded — ignore connection failures.
      const port = opts.port ?? DEFAULT_WORKER_PORT;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 3_000);
      try {
        await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', signal: ctl.signal });
      } catch {
        // ignore — fall through to Stop-ScheduledTask
      } finally {
        clearTimeout(t);
      }
    }
    const r = await runPowerShell(`Stop-ScheduledTask -TaskName ${psSingleQuote(name)}`);
    if (r.exitCode !== 0) {
      throw new Error(`Stop-ScheduledTask ${name} failed (exit ${r.exitCode}): ${r.stderr.trim() || 'no stderr'}`);
    }
    // force: guarantee the worker PROCESS is gone. Stop-ScheduledTask above only
    // asks the scheduler to end the task and does NOT reliably kill a detached/
    // zombie worker — so hard-kill whatever bun process still holds the port, or
    // the next start() will no-op under IgnoreNew (field 2026-06-01). Best-effort:
    // a reclaim failure is non-fatal — the caller's start()+health check surfaces
    // a still-down worker rather than this masking it.
    if (opts?.force) {
      const port = opts.port ?? DEFAULT_WORKER_PORT;
      // Best-effort, exactly as the comment above promises: a reclaim failure (no
      // pwsh/powershell on PATH, an invalid port, a cmdlet error) must NOT
      // propagate — a thrown stop() would skip the caller's subsequent start() and
      // leave the worker STOPPED. The start()+health check is the real safety net;
      // a persistent failure surfaces there, and the next watchdog tick retries.
      try {
        await runPowerShell(buildReclaimPortCommand(port));
      } catch {
        // swallow — reclaim is opportunistic; the worker start proceeds regardless
      }
    }
  }

  async status(name: string): Promise<ServiceState> {
    // Get-ScheduledTask throws if the task doesn't exist → not-installed.
    // Otherwise map the task State: Running → running, anything else → stopped.
    // (Scheduled Tasks have no dedicated "failed" state the way systemd does;
    //  doctor's HTTP /health probe is the authoritative liveness signal.)
    const q = psSingleQuote(name);
    const command =
      `$ErrorActionPreference='Stop'; ` +
      `try { $t = Get-ScheduledTask -TaskName ${q}; ` +
      `Get-ScheduledTaskInfo -TaskName ${q} | Out-Null; ` +
      `Write-Output $t.State } ` +
      `catch { Write-Output 'NotInstalled' }`;
    const r = await runPowerShell(command);
    const state = r.stdout.trim();
    if (state === 'NotInstalled') return 'not-installed';
    if (state === 'Running') return 'running';
    return 'stopped';
  }

  async isActive(name: string): Promise<boolean> {
    return (await this.status(name)) === 'running';
  }

  async enable(name: string): Promise<void> {
    await runPowerShell(`Enable-ScheduledTask -TaskName ${psSingleQuote(name)}`);
  }

  async disable(name: string): Promise<void> {
    await runPowerShell(`Disable-ScheduledTask -TaskName ${psSingleQuote(name)}`);
  }
}

export function createWindowsScheduledTaskServiceManager(): ServiceManager {
  return new WindowsScheduledTaskServiceManager();
}
