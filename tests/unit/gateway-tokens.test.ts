import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadGatewayConfig, saveGatewayConfig, pairNewDevice, verifyToken, revokeDevice,
} from '../../src/shared/gateway-tokens.ts';

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cm-gw-'));
  cfgPath = join(dir, 'gateway.json');
});

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('loadGatewayConfig — missing file returns an empty device list', () => {
  expect(loadGatewayConfig(cfgPath)).toEqual({ devices: [] });
});

test('pairNewDevice — creates a device, persists it, and returns a raw token', () => {
  const { device, token } = pairNewDevice('phone', cfgPath);
  expect(device.label).toBe('phone');
  expect(typeof device.id).toBe('string');
  expect(token.length).toBeGreaterThan(20);

  const reloaded = loadGatewayConfig(cfgPath);
  expect(reloaded.devices).toHaveLength(1);
  expect(reloaded.devices[0]!.id).toBe(device.id);
});

test('pairNewDevice — never stores the raw token on disk (hashed at rest)', () => {
  const { token } = pairNewDevice('phone', cfgPath);
  const raw = readFileSync(cfgPath, 'utf8');
  expect(raw).not.toContain(token);
});

test('verifyToken — a valid token resolves to its device', () => {
  const { device, token } = pairNewDevice('phone', cfgPath);
  const cfg = loadGatewayConfig(cfgPath);
  const found = verifyToken(token, cfg);
  expect(found?.id).toBe(device.id);
});

test('verifyToken — an invalid/garbage token resolves to null', () => {
  pairNewDevice('phone', cfgPath);
  const cfg = loadGatewayConfig(cfgPath);
  expect(verifyToken('totally-made-up-token', cfg)).toBeNull();
});

test('revokeDevice — removes the device; its token no longer verifies', () => {
  const { device, token } = pairNewDevice('phone', cfgPath);
  const removed = revokeDevice(device.id, cfgPath);
  expect(removed).toBe(true);

  const cfg = loadGatewayConfig(cfgPath);
  expect(cfg.devices).toHaveLength(0);
  expect(verifyToken(token, cfg)).toBeNull();
});

test('revokeDevice — an unknown id returns false, does not throw', () => {
  expect(revokeDevice('cm-does-not-exist', cfgPath)).toBe(false);
});

test('pairNewDevice — multiple devices coexist independently', () => {
  const a = pairNewDevice('phone', cfgPath);
  const b = pairNewDevice('laptop', cfgPath);
  const cfg = loadGatewayConfig(cfgPath);
  expect(cfg.devices).toHaveLength(2);
  expect(verifyToken(a.token, cfg)?.id).toBe(a.device.id);
  expect(verifyToken(b.token, cfg)?.id).toBe(b.device.id);
});
