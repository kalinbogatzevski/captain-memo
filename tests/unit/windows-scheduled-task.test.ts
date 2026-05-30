// tests/unit/windows-scheduled-task.test.ts — pure tests for the PowerShell
// command builder. No spawning, no Windows required → runs on Linux CI.
import { test, expect, describe } from 'bun:test';
import { buildRegisterTaskCommand } from '../../src/services/service-manager/windows-scheduled-task.ts';
import type { ServiceSpec } from '../../src/services/service-manager/types.ts';

function sampleSpec(overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    name: 'captain-memo-worker',
    description: 'Captain Memo worker',
    exec: ['C:\\Users\\me\\.bun\\bin\\bun.exe', 'src/worker/index.ts'],
    workingDir: 'C:\\Users\\me\\captain-memo',
    envFile: 'C:\\Users\\me\\AppData\\Roaming\\captain-memo\\worker.env',
    autostart: true,
    restartOnFailure: true,
    logDir: 'C:\\Users\\me\\.captain-memo\\logs',
    ...overrides,
  };
}

describe('buildRegisterTaskCommand', () => {
  test('contains the task name, bun exec path, -AtLogOn, and restart settings', () => {
    const cmd = buildRegisterTaskCommand(sampleSpec());

    // Task name (single-quoted PowerShell literal).
    expect(cmd).toContain("-TaskName 'captain-memo-worker'");
    // Bun exec path is the -Execute target.
    expect(cmd).toContain("-Execute 'C:\\Users\\me\\.bun\\bin\\bun.exe'");
    // Logon trigger (autostart without admin).
    expect(cmd).toContain('-AtLogOn');
    // Restart-on-failure settings.
    expect(cmd).toContain('-RestartCount 3');
    expect(cmd).toContain('-RestartInterval (New-TimeSpan -Minutes 1)');
    expect(cmd).toContain('-MultipleInstances IgnoreNew');
    expect(cmd).toContain('-ExecutionTimeLimit 0');
  });

  test('passes the script path as the -Argument and sets -WorkingDirectory', () => {
    const cmd = buildRegisterTaskCommand(sampleSpec());
    expect(cmd).toContain("-Argument 'src/worker/index.ts'");
    expect(cmd).toContain("-WorkingDirectory 'C:\\Users\\me\\captain-memo'");
  });

  test('registers in non-elevated user context (RunLevel Limited, -Force)', () => {
    const cmd = buildRegisterTaskCommand(sampleSpec());
    expect(cmd).toContain('-RunLevel Limited');
    expect(cmd).toContain('-Force');
    expect(cmd).toContain('Register-ScheduledTask');
  });

  test('omits restart settings when restartOnFailure is false', () => {
    const cmd = buildRegisterTaskCommand(sampleSpec({ restartOnFailure: false }));
    expect(cmd).not.toContain('-RestartCount');
    expect(cmd).not.toContain('New-ScheduledTaskSettingsSet');
    expect(cmd).not.toContain('-Settings');
    // The trigger + action are still there.
    expect(cmd).toContain('-AtLogOn');
    expect(cmd).toContain('Register-ScheduledTask');
  });

  test('escapes embedded single quotes in values (PowerShell doubling)', () => {
    const cmd = buildRegisterTaskCommand(sampleSpec({ name: "weird'name" }));
    expect(cmd).toContain("-TaskName 'weird''name'");
  });

  test('quotes multi-token arguments so a path with spaces survives', () => {
    const cmd = buildRegisterTaskCommand(
      sampleSpec({ exec: ['C:\\bun.exe', 'C:\\Program Files\\cm\\worker.ts', '--port', '39888'] }),
    );
    // The argument string is one single-quoted PS literal; the space-containing
    // token is double-quoted inside it; flag tokens stay bare.
    expect(cmd).toContain(`-Argument '"C:\\Program Files\\cm\\worker.ts" --port 39888'`);
  });

  test('emits no -Argument when there are no script args', () => {
    const cmd = buildRegisterTaskCommand(sampleSpec({ exec: ['C:\\bun.exe'] }));
    expect(cmd).not.toContain('-Argument');
    expect(cmd).toContain("-Execute 'C:\\bun.exe'");
  });
});
