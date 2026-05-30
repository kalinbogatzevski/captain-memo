// src/services/service-manager/windows-scheduled-task.ts — Windows ServiceManager
// over per-user Scheduled Tasks (PowerShell ScheduledTasks module).
//
// Design (spec §4.1): no admin / no UAC. Tasks register in the *current user's*
// context with RunLevel Limited, trigger -AtLogOn, and (when restartOnFailure)
// restart up to 3× at 1-minute intervals with no execution time limit — the
// closest Scheduled-Task analogue to the rootless `systemd --user` + Restart=on-failure
// the Linux impl provides. We prefer `pwsh` (PowerShell 7+) and fall back to the
// in-box `powershell` (Windows PowerShell 5.1); both expose the ScheduledTasks
// cmdlets used here.
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

// Build the `-Argument` value for New-ScheduledTaskAction: everything in
// spec.exec after the executable (exec[0]), joined as a single command-line
// string. Each token is double-quoted so a token containing spaces survives the
// round-trip into the task's argument string. The whole thing is then wrapped in
// a PowerShell single-quoted literal by the caller.
function buildArgumentString(exec: string[]): string {
  return exec
    .slice(1)
    .map((tok) => (/\s/.test(tok) ? `"${tok}"` : tok))
    .join(' ');
}

/**
 * Pure builder for the PowerShell command that registers the Scheduled Task.
 * Exported so the construction can be unit-tested WITHOUT spawning PowerShell
 * (the test runs on Linux CI). The returned string is passed verbatim to
 * `pwsh -Command <this>` (or `powershell -Command <this>`).
 *
 * Mirrors spec §4.1:
 *   New-ScheduledTaskAction -Execute <exec[0]> -Argument '<exec[1..]>' -WorkingDirectory <workingDir>
 *   New-ScheduledTaskTrigger -AtLogOn
 *   New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) \
 *       -MultipleInstances IgnoreNew -ExecutionTimeLimit 0    (only when restartOnFailure)
 *   Register-ScheduledTask -TaskName <name> -Action $a -Trigger $t [-Settings $s] -RunLevel Limited -Force
 */
export function buildRegisterTaskCommand(spec: ServiceSpec): string {
  const exe = spec.exec[0] ?? 'bun';
  const argString = buildArgumentString(spec.exec);

  // -Argument is optional: only emit it when there actually are arguments, so a
  // bare executable doesn't get an empty '' argument string.
  const actionParts = [
    'New-ScheduledTaskAction',
    `-Execute ${psSingleQuote(exe)}`,
  ];
  if (argString.length > 0) actionParts.push(`-Argument ${psSingleQuote(argString)}`);
  actionParts.push(`-WorkingDirectory ${psSingleQuote(spec.workingDir)}`);
  const action = actionParts.join(' ');

  // At-logon trigger → autostart without admin (no boot-time / system trigger).
  const trigger = 'New-ScheduledTaskTrigger -AtLogOn';

  const lines = [
    `$action = ${action}`,
    `$trigger = ${trigger}`,
  ];

  // Restart-on-failure settings only when requested — otherwise omit -Settings
  // entirely so a failed task just stops (matching a unit without Restart=).
  const registerParts = [
    'Register-ScheduledTask',
    `-TaskName ${psSingleQuote(spec.name)}`,
    '-Action $action',
    '-Trigger $trigger',
  ];
  if (spec.restartOnFailure) {
    const settings =
      'New-ScheduledTaskSettingsSet -RestartCount 3 ' +
      '-RestartInterval (New-TimeSpan -Minutes 1) ' +
      '-MultipleInstances IgnoreNew -ExecutionTimeLimit 0';
    lines.push(`$settings = ${settings}`);
    registerParts.push('-Settings $settings');
  }
  // RunLevel Limited = current user's normal token (no elevation / no UAC).
  registerParts.push('-RunLevel Limited');
  registerParts.push('-Force');

  lines.push(registerParts.join(' '));
  return lines.join('; ');
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

class WindowsScheduledTaskServiceManager implements ServiceManager {
  async install(spec: ServiceSpec): Promise<void> {
    const command = buildRegisterTaskCommand(spec);
    const r = await runPowerShell(command);
    if (r.exitCode !== 0) {
      throw new Error(`Register-ScheduledTask failed for ${spec.name}: ${r.stderr.trim() || r.stdout.trim()}`);
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
    await runPowerShell(`Start-ScheduledTask -TaskName ${psSingleQuote(name)}`);
  }

  async stop(name: string, opts?: StopOptions): Promise<void> {
    if (opts?.graceful) {
      // POST /shutdown first so the worker drains + releases SQLite locks before
      // the task is force-stopped. Best-effort — ignore connection failures.
      const port = opts.port ?? DEFAULT_WORKER_PORT;
      try {
        await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' });
      } catch {
        // ignore — fall through to Stop-ScheduledTask
      }
    }
    await runPowerShell(`Stop-ScheduledTask -TaskName ${psSingleQuote(name)}`);
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
