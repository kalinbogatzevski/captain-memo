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

  const lines = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${xmlEscape(spec.description)}</Description>`,
    `    <URI>\\${xmlEscape(spec.name)}</URI>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
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
  const proc = Bun.spawn(['schtasks', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

class WindowsScheduledTaskServiceManager implements ServiceManager {
  async install(spec: ServiceSpec): Promise<void> {
    const xml = buildTaskXml(spec);
    // Write the spec to a temp file and hand it to schtasks /XML. We do NOT pipe
    // it on stdin — schtasks only reads the XML from a path.
    const xmlPath = join(tmpdir(), `captain-memo-task-${spec.name}-${process.pid}-${Date.now()}.xml`);
    writeFileSync(xmlPath, xml);
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
