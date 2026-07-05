// Token store for the local device-pairing gateway (GitHub #6). A "device" here is just an
// authenticated client of the SAME single worker/corpus every local session already uses —
// no separate identity, no peer/federation concept. See
// docs/superpowers/specs/2026-07-05-local-device-pairing-design.md.
//
// defaultGatewayConfigPath() is recomputed on every call (not a frozen module-level const)
// so it honors CAPTAIN_MEMO_DATA_DIR set at any point — including a test's beforeEach —
// matching the pattern src/services/backup/create.ts already uses for the same reason.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { sha256Hex } from './sha.ts';

function defaultGatewayConfigPath(): string {
  const dataDir = process.env.CAPTAIN_MEMO_DATA_DIR ?? join(homedir(), '.captain-memo');
  return join(dataDir, 'gateway.json');
}

export interface GatewayDevice {
  id: string;
  label: string;
  /** SHA-256 hex of the raw token. The raw token is shown to the operator exactly once
   *  (at pair time) and never written to disk. */
  token_hash: string;
  created_at_epoch: number;
}

export interface GatewayConfig {
  devices: GatewayDevice[];
}

export function loadGatewayConfig(path: string = defaultGatewayConfigPath()): GatewayConfig {
  if (!existsSync(path)) return { devices: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { devices: Array.isArray(parsed?.devices) ? parsed.devices : [] };
  } catch {
    // Never crash the worker/CLI on a corrupt gateway.json — treat as no devices paired.
    return { devices: [] };
  }
}

export function saveGatewayConfig(cfg: GatewayConfig, path: string = defaultGatewayConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function randomToken(): string {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

/** Mint a new device + raw token, persist the HASH, and return the raw token for one-time display.
 *  The caller (the CLI's `gateway pair` command) is responsible for printing it — it is never
 *  recoverable after this call returns. */
export function pairNewDevice(label: string, path: string = defaultGatewayConfigPath()): { device: GatewayDevice; token: string } {
  const cfg = loadGatewayConfig(path);
  const token = randomToken();
  const device: GatewayDevice = {
    id: `dev_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    label,
    token_hash: sha256Hex(token),
    created_at_epoch: Math.floor(Date.now() / 1000),
  };
  saveGatewayConfig({ devices: [...cfg.devices, device] }, path);
  return { device, token };
}

/** Resolve a raw bearer token to its device, or null if it doesn't match any paired device.
 *  Never throws — a malformed/empty token simply resolves to null. */
export function verifyToken(token: string, cfg: GatewayConfig): GatewayDevice | null {
  if (!token) return null;
  const hash = sha256Hex(token);
  return cfg.devices.find((d) => d.token_hash === hash) ?? null;
}

/** Remove a paired device by id. Returns whether a device was actually removed
 *  (false for an unknown id — never throws). */
export function revokeDevice(id: string, path: string = defaultGatewayConfigPath()): boolean {
  const cfg = loadGatewayConfig(path);
  const next = cfg.devices.filter((d) => d.id !== id);
  if (next.length === cfg.devices.length) return false;
  saveGatewayConfig({ devices: next }, path);
  return true;
}
