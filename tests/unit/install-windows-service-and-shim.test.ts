// A worker Scheduled Task that will not register must not stop the Windows install from writing the CLI shim.
// `schtasks /Create failed for captain-memo-worker: ERROR: Access is denied.` used to throw out of installWindows,
// "Linking CLI shim" never ran, and a stale copied captain-memo.cmd stayed on PATH.
// installWindows itself cannot run on Linux (bun probe, prompts, icacls, the plugin CLI); the step it now delegates to can.
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installWindowsServiceAndShim, windowsWorkerTaskFailureLines, windowsCliShim } from '../../src/cli/commands/install.ts';
import type { ServiceManager, ServiceSpec } from '../../src/services/service-manager/types.ts';

const root = mkdtempSync(join(tmpdir(), 'cm-win-install-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SPEC: ServiceSpec = { name: 'captain-memo-worker', description: 'x', exec: ['wscript.exe'], workingDir: 'C:\\cm', autostart: true, restartOnFailure: true, logDir: 'C:\\logs' };
// The exact shape windows-scheduled-task.ts install() throws (`schtasks /Create failed for ${name}: ${stderr}`).
const DENIED = 'schtasks /Create failed for captain-memo-worker: ERROR: Access is denied.';

function fakeSm(over: Partial<ServiceManager> = {}): { sm: ServiceManager; calls: string[] } {
  const calls: string[] = [];
  const sm = {
    install: async (s: ServiceSpec) => { calls.push(`install:${s.name}`); },
    restart: async (n: string, o?: unknown) => { calls.push(`restart:${n}:${JSON.stringify(o)}`); },
    status: async (n: string) => { calls.push(`status:${n}`); return 'not-installed'; },
    remove: async (n: string) => { calls.push(`remove:${n}`); },
    ...over,
  } as unknown as ServiceManager;
  return { sm, calls };
}

const shimIn = (name: string) => ({ path: join(root, name, 'LocalAppData', 'captain-memo', 'bin', 'captain-memo.cmd'), installDir: 'C:\\projects\\captain-memo' });

test('a task that will not register: the failure is returned, the shim is STILL written (fresh bin dir), the restart is not attempted', async () => {
  const { sm, calls } = fakeSm({ install: async () => { throw new Error(DENIED); } });
  const shim = shimIn('denied');
  const failure = await installWindowsServiceAndShim(sm, SPEC, 39888, shim);
  expect(failure).toBe(DENIED);
  expect(readFileSync(shim.path, 'utf-8')).toBe(windowsCliShim(shim.installDir));
  expect(calls.some((c) => c.startsWith('restart:'))).toBe(false);   // there is nothing new to restart onto
  expect(calls).toContain('status:captain-memo-watchdog');            // the best-effort cleanup still ran
});

test('a stale shim from an old install is REPLACED even though the task step threw', async () => {
  const shim = shimIn('stale');
  mkdirSync(join(shim.path, '..'), { recursive: true });
  writeFileSync(shim.path, '@echo off\r\nbun "%~dp0..\\src\\cli\\index.ts" %*\r\n');
  const { sm } = fakeSm({ install: async () => { throw new Error(DENIED); } });
  await installWindowsServiceAndShim(sm, SPEC, 39888, shim);
  expect(readFileSync(shim.path, 'utf-8')).not.toContain('%~dp0');
  expect(readFileSync(shim.path, 'utf-8')).toContain('bun "C:\\projects\\captain-memo\\src\\cli\\index.ts" %*');
});

test('a restart that fails after a good registration is reported the same way, shim written', async () => {
  const { sm } = fakeSm({ restart: async () => { throw new Error('Stop-ScheduledTask failed'); } });
  const shim = shimIn('restart');
  expect(await installWindowsServiceAndShim(sm, SPEC, 39888, shim)).toBe('Stop-ScheduledTask failed');
  expect(existsSync(shim.path)).toBe(true);
});

test('success path unchanged: install, then a forced graceful restart on the port; null; shim written', async () => {
  const order: string[] = [];
  const { sm } = fakeSm({
    install: async () => { order.push('install'); },
    restart: async (n, o) => { order.push(`restart:${n}:${JSON.stringify(o)}`); },
  });
  const shim = shimIn('ok');
  expect(await installWindowsServiceAndShim(sm, SPEC, 39888, shim)).toBeNull();
  expect(order).toEqual(['install', 'restart:captain-memo-worker:{"graceful":true,"port":39888,"force":true}']);
  expect(readFileSync(shim.path, 'utf-8')).toBe(windowsCliShim(shim.installDir));
});

test('the shim step cannot throw out either: an unwritable bin dir is a warning, and the task result is still returned', async () => {
  const blocker = join(root, 'blocker');
  writeFileSync(blocker, 'a file where a directory is needed');
  const shim = { path: join(blocker, 'captain-memo', 'bin', 'captain-memo.cmd'), installDir: 'C:\\cm' };
  expect(await installWindowsServiceAndShim(fakeSm().sm, SPEC, 39888, shim)).toBeNull();
  const failing = await installWindowsServiceAndShim(fakeSm({ install: async () => { throw new Error(DENIED); } }).sm, SPEC, 39888, shim);
  expect(failing).toBe(DENIED);
});

// --- what the person is told ------------------------------------------------------------------------------
test('an Access-is-denied /Create failure: the cause is HEDGED, both checks and the fix are named', () => {
  const text = windowsWorkerTaskFailureLines(DENIED).join('\n');
  expect(text).toContain(DENIED);
  expect(text).toContain('may have been registered from an Administrator shell');
  expect(text).toContain('not confirmed on this machine');
  expect(text).not.toMatch(/was registered from an Administrator/);   // a hypothesis is not stated as a fact
  expect(text).toContain('Get-ScheduledTask -TaskName captain-memo-worker | Select -ExpandProperty Principal');
  expect(text).toMatch(/does NOT show who may overwrite it/);         // the Principal does not discriminate; the descriptor does
  expect(text).toContain("GetFolder('\\').GetTask('captain-memo-worker').GetSecurityDescriptor(5)");
  expect(text).toContain('Unregister-ScheduledTask -TaskName captain-memo-worker -Confirm:$false');
  expect(text).toContain('Administrator PowerShell');
  expect(text).toContain('normal PowerShell');
  expect(text).toContain('bun src\\cli\\index.ts install --yes');
});

test('any other failure: the message and the re-run, but no Administrator-shell guess', () => {
  const text = windowsWorkerTaskFailureLines('Start-ScheduledTask captain-memo-worker failed (exit 1): no stderr').join('\n');
  expect(text).toContain('Start-ScheduledTask captain-memo-worker failed (exit 1)');
  expect(text).not.toContain('Administrator');
  expect(text).toContain('bun src\\cli\\index.ts install --yes');
});

// --- wiring pins (installWindows cannot run on this box) ----------------------------------------------------
test('installWindows hands the service and shim steps to the step above and exits non-zero on its failure, reported after the other steps', () => {
  const src = readFileSync(join(import.meta.dir, '../../src/cli/commands/install.ts'), 'utf-8');
  const win = src.slice(src.indexOf('async function installWindows('), src.indexOf('export async function installCommand('));
  expect(win).toContain('await installWindowsServiceAndShim(getServiceManager(),');
  expect(win).not.toMatch(/getServiceManager\(\)\.install\(\{\s*name: 'captain-memo-worker'/);   // no unwrapped registration left
  expect(win).toMatch(/if \(workerTaskFailure\) \{[^}]*return 1;\s*\}/);
  expect(win.indexOf('wireCrossAi(opts)')).toBeLessThan(win.indexOf('if (workerTaskFailure)'));
  const cli = readFileSync(join(import.meta.dir, '../../src/cli/index.ts'), 'utf-8');
  expect(cli).toMatch(/exit = await installCommand\(args\.slice\(1\)\);/);
  expect(cli).toContain('process.exit(exit);');
});
