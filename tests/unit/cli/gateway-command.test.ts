import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gatewayCommand } from '../../../src/cli/commands/gateway.ts';
import { loadGatewayConfig } from '../../../src/shared/gateway-tokens.ts';

let dir: string;
let prevDataDir: string | undefined;

function capture(fn: () => Promise<number>): Promise<{ out: string; code: number }> {
  const origLog = console.log, origErr = console.error;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  return fn().then(
    (code) => { console.log = origLog; console.error = origErr; return { out: lines.join('\n'), code }; },
    (err) => { console.log = origLog; console.error = origErr; throw err; },
  );
}

beforeEach(() => {
  prevDataDir = process.env.CAPTAIN_MEMO_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), 'cm-gwcmd-'));
  process.env.CAPTAIN_MEMO_DATA_DIR = dir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.CAPTAIN_MEMO_DATA_DIR;
  else process.env.CAPTAIN_MEMO_DATA_DIR = prevDataDir;
  rmSync(dir, { recursive: true, force: true });
});

test('gateway pair --label — prints a token + connector URL, exits 0', async () => {
  const { out, code } = await capture(() => gatewayCommand(['pair', '--label', 'phone']));
  expect(code).toBe(0);
  expect(out).toContain('phone');
  expect(out.toLowerCase()).toContain('token');
});

test('gateway pair — missing --label prints usage, exits 2', async () => {
  const { out, code } = await capture(() => gatewayCommand(['pair']));
  expect(code).toBe(2);
  expect(out).toContain('usage');
});

test('gateway list — shows a previously paired device', async () => {
  await capture(() => gatewayCommand(['pair', '--label', 'laptop']));
  const { out, code } = await capture(() => gatewayCommand(['list']));
  expect(code).toBe(0);
  expect(out).toContain('laptop');
});

test('gateway list — no devices paired prints an empty/informative message, exits 0', async () => {
  const { out, code } = await capture(() => gatewayCommand(['list']));
  expect(code).toBe(0);
  expect(out.length).toBeGreaterThan(0);
});

test('gateway revoke <id> — removes a paired device', async () => {
  await capture(() => gatewayCommand(['pair', '--label', 'tablet']));
  const cfg = loadGatewayConfig(join(dir, 'gateway.json'));
  const id = cfg.devices[0]!.id;

  const { code } = await capture(() => gatewayCommand(['revoke', id]));
  expect(code).toBe(0);
  expect(loadGatewayConfig(join(dir, 'gateway.json')).devices).toHaveLength(0);
});

test('gateway revoke — unknown id exits 1, does not throw', async () => {
  const { code } = await capture(() => gatewayCommand(['revoke', 'dev_doesnotexist']));
  expect(code).toBe(1);
});

test('gateway — unknown subcommand exits 2', async () => {
  const { code } = await capture(() => gatewayCommand(['not-a-real-subcommand']));
  expect(code).toBe(2);
});
