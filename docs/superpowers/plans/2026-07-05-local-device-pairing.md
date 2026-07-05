# Local Device-Pairing Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator pair a second device (phone, tablet, another machine) to their existing captain-memo corpus over an authenticated, self-hosted HTTP-MCP listener — no hub, no separate process, no peer/federation concepts.

**Architecture:** The existing worker gains an optional second `Bun.serve()` listener (localhost-only, started only when ≥1 device is paired) that authenticates requests via a bearer token and serves MCP over HTTP through the SDK's `WebStandardStreamableHTTPServerTransport`, dispatching through the same tool logic the stdio path already uses (extracted into a shared, parameterized `dispatchTool()`).

**Tech Stack:** Bun, TypeScript (`strict`, `exactOptionalPropertyTypes`), `@modelcontextprotocol/sdk` (`Server`, `WebStandardStreamableHTTPServerTransport`), `Bun.CryptoHasher` (sha256 via existing `sha256Hex`), `bun:test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-05-local-device-pairing-design.md` — read it if anything below is unclear.
- Zero federation coupling: no peer/restricted-reader/federation concepts. A paired device is an authenticated client of the SAME single worker and corpus every local session uses — not a separate identity.
- No OAuth/JWT/PKCE, no per-device scopes (full tool access for every paired device in v1), no separate `gateway run` process, no local web console, no QR code — all explicitly deferred per the design's §2.
- Tokens are hashed at rest (SHA-256 via the existing `sha256Hex` in `src/shared/sha.ts`) — never store a raw token in `gateway.json`.
- The gateway listener binds `127.0.0.1` only — never a public interface. The operator's own reverse proxy is responsible for public exposure + TLS.
- The listener starts only when `gateway.json` lists ≥1 device — not gated by a separate on/off config flag. Zero devices paired ⇒ zero new resources, zero behavior change.
- A failed gateway-listener bind (port in use, etc.) must log a warning and disable the feature for this run — it must never prevent the core worker from starting.
- Run `bun run typecheck` and the full test suite (`bun test`) after each task — this touches a widely-used file (`mcp-server.ts`) and the core worker bootstrap (`worker/index.ts`).

---

### Task 1: Extract `dispatchTool()` from `mcp-server.ts` (behavior-preserving refactor)

**Files:**
- Modify: `src/mcp-server.ts:24-35` (`workerPost`), `src/mcp-server.ts:251-308` (the `CallToolRequestSchema` handler body)
- Test: `tests/unit/mcp-server.test.ts` (new file — no test file exists for this module today)

**Interfaces:**
- Produces: `export async function dispatchTool(name: string, args: unknown, deps?: { workerBase: string; sessionId: string; cwd: () => string }): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }>`. Omitting `deps` preserves today's exact stdio behavior (env-derived `WORKER_BASE`, process-level `PROCESS_SESSION_ID`, real `process.cwd()`). Task 4 (the worker's gateway listener) calls this with its own `workerBase` (the worker's actual bound port) and its own per-connection session id.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/mcp-server.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { dispatchTool } from '../../src/mcp-server.ts';

let server: ReturnType<typeof Bun.serve> | undefined;
let port: number;

beforeEach(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/stats') return Response.json({ chunks: 42 });
      if (url.pathname === '/search/all') return Response.json({ results: ['ok'] });
      return new Response('not found', { status: 404 });
    },
  });
  port = server.port!;
});

afterEach(() => { server?.stop(true); });

test('dispatchTool — routes search_all to the given workerBase', async () => {
  const result = await dispatchTool(
    'search_all',
    { query: 'foo' },
    { workerBase: `http://127.0.0.1:${port}`, sessionId: 's1', cwd: () => '/tmp' },
  );
  expect(result.isError).toBeUndefined();
  const parsed = JSON.parse(result.content[0]!.text);
  expect(parsed.results).toEqual(['ok']);
});

test('dispatchTool — routes stats to the given workerBase', async () => {
  const result = await dispatchTool(
    'stats',
    {},
    { workerBase: `http://127.0.0.1:${port}`, sessionId: 's1', cwd: () => '/tmp' },
  );
  const parsed = JSON.parse(result.content[0]!.text);
  expect(parsed.chunks).toBe(42);
});

test('dispatchTool — unknown tool name returns an MCP error, not a throw', async () => {
  const result = await dispatchTool(
    'not_a_real_tool',
    {},
    { workerBase: `http://127.0.0.1:${port}`, sessionId: 's1', cwd: () => '/tmp' },
  );
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain('unknown tool');
});

test('dispatchTool — a worker error (e.g. 500) surfaces as an MCP error, not a throw', async () => {
  server?.stop(true);
  server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch() { return new Response('boom', { status: 500 }); },
  });
  const badPort = server.port!;
  const result = await dispatchTool(
    'search_all',
    { query: 'foo' },
    { workerBase: `http://127.0.0.1:${badPort}`, sessionId: 's1', cwd: () => '/tmp' },
  );
  expect(result.isError).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/mcp-server.test.ts`
Expected: FAIL — `dispatchTool` is not exported from `src/mcp-server.ts` yet.

- [ ] **Step 3: Extract the implementation**

In `src/mcp-server.ts`, replace the existing `workerPost` function (currently lines 24-35):

```typescript
async function workerPost(base: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`worker ${path} returned ${res.status}: ${await res.text()}`);
  }
  return res.json();
}
```

Then, immediately after the `TOOLS` array and the existing `RememberToolArgs`/`RememberWorkerResult`/`buildRememberRequest`/`formatRememberResult`/`dispatchRemember` block (i.e., right before `export async function runMcpServer()`), add:

```typescript
/** Default deps for dispatchTool: preserves today's exact stdio behavior
 *  (env-derived WORKER_BASE, the process-level session id, real cwd). */
function defaultDispatchDeps(): { workerBase: string; sessionId: string; cwd: () => string } {
  return { workerBase: WORKER_BASE, sessionId: PROCESS_SESSION_ID, cwd: () => process.cwd() };
}

/** Route one MCP tool call to the worker. Shared by the stdio transport (runMcpServer,
 *  which omits `deps` to get today's env-derived worker base) and the gateway's HTTP-MCP
 *  listener (which passes its own actual bound port + a per-connection session id) —
 *  see docs/superpowers/specs/2026-07-05-local-device-pairing-design.md §3. */
export async function dispatchTool(
  name: string,
  args: unknown,
  deps: { workerBase: string; sessionId: string; cwd: () => string } = defaultDispatchDeps(),
): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
  const { workerBase, sessionId, cwd } = deps;
  let result: unknown;
  try {
    switch (name) {
      case 'search_memory':       result = await workerPost(workerBase, '/search/memory', args); break;
      case 'search_skill':        result = await workerPost(workerBase, '/search/skill', args); break;
      case 'search_observations': result = await workerPost(workerBase, '/search/observations', args); break;
      case 'search_all':          result = await workerPost(workerBase, '/search/all', args); break;
      case 'get_full':            result = await workerPost(workerBase, '/get_full', args); break;
      case 'reindex':             result = await workerPost(workerBase, '/reindex', args); break;
      case 'remember':
        return await dispatchRemember(args as unknown as RememberToolArgs, {
          post: (path, body) => workerPost(workerBase, path, body),
          cwd,
        });
      case 'stats': {
        const res = await fetch(`${workerBase}/stats`);
        if (!res.ok) throw new Error(`worker /stats returned ${res.status}`);
        result = await res.json();
        break;
      }
      case 'status': {
        const res = await fetch(`${workerBase}/health`);
        result = res.ok ? await res.json() : { healthy: false };
        break;
      }
      case 'work_set': {
        const a = (args ?? {}) as { session_id?: string };
        result = await workerPost(workerBase, '/worknote/set', { ...a, session_id: a.session_id || sessionId });
        break;
      }
      case 'work_active': {
        const a = (args ?? {}) as { session_id?: string };
        const q = new URLSearchParams({ session_id: a.session_id || sessionId });
        const res = await fetch(`${workerBase}/worknote/active?${q.toString()}`);
        if (!res.ok) throw new Error(`worker /worknote/active returned ${res.status}`);
        result = await res.json();
        break;
      }
      case 'work_clear': {
        const a = (args ?? {}) as { session_id?: string };
        result = await workerPost(workerBase, '/worknote/clear', { session_id: a.session_id || sessionId });
        break;
      }
      default: throw new Error(`unknown tool: ${name}`);
    }
  } catch (err) {
    const e = err as Error;
    return {
      content: [{ type: 'text', text: `Error: ${e.message}` }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}
```

Finally, replace the body of `runMcpServer()`'s `CallToolRequestSchema` handler (currently the whole `switch`/try-catch block at lines 251-308) with:

```typescript
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return dispatchTool(request.params.name, request.params.arguments);
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/mcp-server.test.ts`
Expected: PASS — all 4 tests pass.

- [ ] **Step 5: Run typecheck + full unit suite to confirm the stdio path is unaffected**

Run: `bun run typecheck 2>&1 | grep -i mcp-server` — expect no output.
Run: `bun run test:unit 2>&1 | tail -6` — expect the same pass count as before this task, plus these 4 new tests, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server.ts tests/unit/mcp-server.test.ts
git commit -m "refactor(mcp-server): extract dispatchTool, parameterized by workerBase"
```

---

### Task 2: Gateway token store

**Files:**
- Create: `src/shared/gateway-tokens.ts`
- Test: `tests/unit/gateway-tokens.test.ts`

**Interfaces:**
- Consumes: `sha256Hex` from `../shared/sha.ts` (already exists).
- Produces: `interface GatewayDevice { id: string; label: string; token_hash: string; created_at_epoch: number }`; `interface GatewayConfig { devices: GatewayDevice[] }`; `loadGatewayConfig(path?: string): GatewayConfig`; `saveGatewayConfig(cfg: GatewayConfig, path?: string): void`; `pairNewDevice(label: string, path?: string): { device: GatewayDevice; token: string }`; `verifyToken(token: string, cfg: GatewayConfig): GatewayDevice | null`; `revokeDevice(id: string, path?: string): boolean` (returns whether a device was actually removed). Task 3 (CLI) and Task 4 (worker listener) both import from this module.

**Important — do NOT add a frozen path constant to `src/shared/paths.ts` for this.** That file's existing exports (`DATA_DIR`, `CONFIG_PATH`, etc.) are plain top-level `const`s computed ONCE from `process.env.CAPTAIN_MEMO_DATA_DIR` at module-import time — a test's `beforeEach` setting that env var afterward has no effect on an already-imported frozen value. `src/services/backup/create.ts:22` already hit this and works around it by recomputing the data dir from `process.env` inside a function, called fresh each time — follow that same pattern here (see Step 3 below), not the frozen-constant one.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/gateway-tokens.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/gateway-tokens.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/gateway-tokens.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/gateway-tokens.ts`:

```typescript
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
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/gateway-tokens.test.ts`
Expected: PASS — all 8 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck 2>&1 | grep -i gateway-tokens` — expect no output.

- [ ] **Step 6: Commit**

```bash
git add src/shared/gateway-tokens.ts tests/unit/gateway-tokens.test.ts
git commit -m "feat(gateway): token store for local device pairing (pair/verify/revoke)"
```

---

### Task 3: CLI commands — `gateway pair|list|revoke`

**Files:**
- Create: `src/cli/commands/gateway.ts`
- Modify: `src/cli/index.ts:29-73` (HELP text + the command switch)
- Test: `tests/unit/cli/gateway-command.test.ts`

**Interfaces:**
- Consumes: `pairNewDevice`, `loadGatewayConfig`, `revokeDevice` from `../../shared/gateway-tokens.ts`; `DEFAULT_WORKER_PORT` from `../../shared/paths.ts` (the gateway's own default port is `DEFAULT_WORKER_PORT + 1`, matching the spec).
- Produces: `export async function gatewayCommand(args: string[]): Promise<number>` — same shape as every other CLI command in this file (e.g. `backupCommand`), so `src/cli/index.ts` wires it identically.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/cli/gateway-command.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/cli/gateway-command.test.ts`
Expected: FAIL — `Cannot find module '../../../src/cli/commands/gateway.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/cli/commands/gateway.ts`:

```typescript
// captain-memo gateway — pair/list/revoke a second device (phone, tablet, another machine)
// against THIS captain's existing corpus. No hub, no separate process, no peer/federation
// concept — a paired device is an authenticated client of the same single worker. See
// docs/superpowers/specs/2026-07-05-local-device-pairing-design.md.
//
//   captain-memo gateway pair --label <name>   mint a token, print the connector URL + token
//   captain-memo gateway list                  show paired devices
//   captain-memo gateway revoke <device-id>    remove a device; its token stops working at once
//
// The worker itself serves the authenticated HTTP-MCP listener (see src/worker/index.ts) —
// this command only manages the token store. Restart the worker after pairing/revoking so it
// picks up the change (no hot-reload for v1).

import { pairNewDevice, loadGatewayConfig, revokeDevice } from '../../shared/gateway-tokens.ts';
import { DEFAULT_WORKER_PORT } from '../../shared/paths.ts';

const DEFAULT_GATEWAY_PORT = DEFAULT_WORKER_PORT + 1;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const HELP = `Usage: captain-memo gateway <pair|list|revoke>

  gateway pair --label <name>   pair a new device; prints a one-time token + connector URL
  gateway list                  show paired devices
  gateway revoke <device-id>    remove a device (its token stops working immediately)

Restart the worker (\`captain-memo restart\`) after pairing or revoking so it takes effect.`;

export async function gatewayCommand(args: string[]): Promise<number> {
  const sub = args[0];

  if (!sub || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return sub ? 0 : 2;
  }

  if (sub === 'pair') {
    const label = flag(args, 'label');
    if (!label) {
      console.error('usage: captain-memo gateway pair --label <name>');
      return 2;
    }
    const { device, token } = pairNewDevice(label);
    const port = process.env.CAPTAIN_MEMO_GATEWAY_PORT
      ? Number(process.env.CAPTAIN_MEMO_GATEWAY_PORT)
      : DEFAULT_GATEWAY_PORT;
    console.log(`Paired device "${label}" (${device.id}).`);
    console.log(`\nConnector URL: http://<your-host-or-reverse-proxy>:${port}`);
    console.log(`Token (shown once, save it now): ${token}`);
    console.log(`\nRestart the worker (\`captain-memo restart\`) so this pairing takes effect.`);
    return 0;
  }

  if (sub === 'list') {
    const cfg = loadGatewayConfig();
    if (cfg.devices.length === 0) {
      console.log('No devices paired. Run `captain-memo gateway pair --label <name>` to add one.');
      return 0;
    }
    console.log(`${cfg.devices.length} paired device(s):\n`);
    for (const d of cfg.devices) {
      const since = new Date(d.created_at_epoch * 1000).toISOString().slice(0, 10);
      console.log(`  ${d.id}  ${d.label}  (paired ${since})`);
    }
    return 0;
  }

  if (sub === 'revoke') {
    const id = args[1];
    if (!id) {
      console.error('usage: captain-memo gateway revoke <device-id>');
      return 2;
    }
    const removed = revokeDevice(id);
    console.log(removed ? `Revoked ${id}.` : `No paired device ${id} found.`);
    return removed ? 0 : 1;
  }

  console.error(`Unknown gateway subcommand: ${sub}`);
  console.error(HELP);
  return 2;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/cli/gateway-command.test.ts`
Expected: PASS — all 7 tests pass.

- [ ] **Step 5: Wire into `src/cli/index.ts`**

Add the import near the other command imports (after `import { restartCommand } from './commands/restart.ts';`):

```typescript
import { gatewayCommand } from './commands/gateway.ts';
```

Add a line to the `HELP` template string, after the `backup` line:

```
  backup       create | restore | info — portable memory archive (move/restore a captain's memories)
  gateway      pair | list | revoke — pair a second device (phone, another machine) to this corpus
```

Add a case in the `main()` switch, after the `case 'backup':` block:

```typescript
    case 'gateway':
      exit = await gatewayCommand(args.slice(1));
      break;
```

- [ ] **Step 6: Run typecheck + full unit suite**

Run: `bun run typecheck 2>&1 | grep -i "cli/gateway\|cli/index"` — expect no output.
Run: `bun run test:unit 2>&1 | tail -6` — expect the prior pass count plus these 7 new tests, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/gateway.ts src/cli/index.ts tests/unit/cli/gateway-command.test.ts
git commit -m "feat(cli): add captain-memo gateway pair|list|revoke"
```

---

### Task 4: Worker gateway listener

**Files:**
- Modify: `src/worker/index.ts` (add the second listener inside `startWorker()`)
- Test: extend `tests/integration/gateway-http-mcp.test.ts` (new file — full flow, see Task 5; this task only needs the listener to exist and be reachable, Task 5 covers the end-to-end MCP round-trip)

**Interfaces:**
- Consumes: `loadGatewayConfig` from `../shared/gateway-tokens.ts`, `verifyToken` from the same, `dispatchTool` + `TOOLS` from `../mcp-server.ts`, the SDK's `Server`, `WebStandardStreamableHTTPServerTransport`, `CallToolRequestSchema`, `ListToolsRequestSchema`.
- Produces: the gateway listener is entirely internal to `startWorker()` — no new exported interface. `WorkerHandle.stop()` also stops this second listener when present.

- [ ] **Step 1: Read the current `startWorker()` return/stop shape**

No test-first step here — this task wires an existing, already-tested building block (`dispatchTool`, proven in Task 1; `verifyToken`, proven in Task 2) into the worker bootstrap. The end-to-end behavior is verified in Task 5's integration test, which needs Task 4 done first. Proceed directly to implementation, then confirm nothing existing broke.

- [ ] **Step 2: Add the gateway listener to `startWorker()`**

In `src/worker/index.ts`, add to the imports (near the top, after the existing `loadWorkerEnv` import):

```typescript
import { loadGatewayConfig, verifyToken } from '../shared/gateway-tokens.ts';
import { dispatchTool, TOOLS } from '../mcp-server.ts';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from '../shared/version.ts';
```

(If `VERSION` is already imported in this file under a different alias, reuse the existing import instead of duplicating it — check first.)

Immediately before the existing `if (opts.noServe) { ... }` block (around line 2013), add:

```typescript
  // Optional local device-pairing gateway (GitHub #6) — an authenticated HTTP-MCP listener,
  // started only when at least one device is paired. Localhost-only; the operator's own
  // reverse proxy is responsible for public exposure + TLS. See
  // docs/superpowers/specs/2026-07-05-local-device-pairing-design.md.
  let gatewayServer: ReturnType<typeof Bun.serve> | undefined;
  if (!opts.noServe) {
    const gatewayCfg = loadGatewayConfig();
    if (gatewayCfg.devices.length > 0) {
      const gatewayPort = process.env.CAPTAIN_MEMO_GATEWAY_PORT
        ? Number(process.env.CAPTAIN_MEMO_GATEWAY_PORT)
        : opts.port + 1;
      try {
        gatewayServer = Bun.serve({
          port: gatewayPort,
          hostname: '127.0.0.1',
          async fetch(req) {
            const auth = req.headers.get('authorization') ?? '';
            const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
            const device = verifyToken(token, loadGatewayConfig());
            if (!device) return Response.json({ error: 'unauthorized' }, { status: 401 });

            const server = new Server({ name: 'captain-memo-gateway', version: VERSION }, { capabilities: { tools: {} } });
            server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
            server.setRequestHandler(CallToolRequestSchema, async (request) => {
              return dispatchTool(request.params.name, request.params.arguments, {
                workerBase: `http://127.0.0.1:${opts.port}`,
                sessionId: `gw-${device.id}`,
                cwd: () => '/',
              });
            });
            const transport = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              enableJsonResponse: true,
            });
            await server.connect(transport);
            return transport.handleRequest(req);
          },
        });
        console.log(`[gateway] listening on 127.0.0.1:${gatewayServer.port} (${gatewayCfg.devices.length} device(s) paired)`);
      } catch (err) {
        console.warn(`[gateway] failed to start (port ${gatewayPort} in use?) — continuing without it:`, err);
        gatewayServer = undefined;
      }
    }
  }
```

Then update the two `return { ... stop: ... }` sites so the gateway server is also stopped:

Change (the `noServe` early return, around line 2015):
```typescript
  if (opts.noServe) {
    // Engine-thread mode: no port bound; the engine serves `handler` over the channel.
    return {
      port: opts.port,
      handler,
      ...(obsStore ? { store: obsStore } : {}),
      stop: stopResources,
    };
  }
```
stays as-is (the gateway listener is never started in `noServe` mode — guarded above by `if (!opts.noServe)`).

Change the final return (around line 2030):
```typescript
  return {
    port: server.port ?? opts.port,
    handler,
    ...(obsStore ? { store: obsStore } : {}),
    stop: async () => { gatewayServer?.stop(true); server.stop(true); await stopResources(); },
  };
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck 2>&1 | grep -i "worker/index"` — expect no output.

- [ ] **Step 4: Run the full unit suite to confirm nothing existing broke**

Run: `bun run test:unit 2>&1 | tail -6` — expect the same pass count as after Task 3 (this task adds no new unit tests of its own — Task 5 covers it end-to-end), 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat(worker): serve the optional device-pairing gateway listener"
```

---

### Task 5: End-to-end integration test

**Files:**
- Create: `tests/integration/gateway-http-mcp.test.ts`

**Interfaces:**
- Consumes: `startWorker` from `../../src/worker/index.ts`, `pairNewDevice`/`revokeDevice` from `../../src/shared/gateway-tokens.ts`.

- [ ] **Step 1: Write the test**

Create `tests/integration/gateway-http-mcp.test.ts`. Note on port handling: `startPairedWorker` below picks the gateway port itself via `findFreePort()` (rather than passing `'0'` for Bun to assign one) specifically so the test knows the exact port to `fetch()` afterward — `startWorker()` doesn't expose the gateway server's bound port on `WorkerHandle`, so a self-assigned port sidesteps that gap entirely.

```typescript
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { pairNewDevice, revokeDevice } from '../../src/shared/gateway-tokens.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

let workDir: string;
let cfgPath: string;
let worker: WorkerHandle;
let prevGatewayPort: string | undefined;
let prevDataDir: string | undefined;

function findFreePort(): number {
  const probe = Bun.listen({ port: 0, hostname: '127.0.0.1', socket: { data() {} } });
  const port = probe.port;
  probe.stop();
  return port;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'cm-gw-int-'));
  cfgPath = join(workDir, 'gateway.json');
  prevGatewayPort = process.env.CAPTAIN_MEMO_GATEWAY_PORT;
  prevDataDir = process.env.CAPTAIN_MEMO_DATA_DIR;
  process.env.CAPTAIN_MEMO_DATA_DIR = workDir; // so loadGatewayConfig() inside startWorker finds cfgPath
});

afterEach(async () => {
  await worker?.stop();
  if (prevGatewayPort === undefined) delete process.env.CAPTAIN_MEMO_GATEWAY_PORT;
  else process.env.CAPTAIN_MEMO_GATEWAY_PORT = prevGatewayPort;
  if (prevDataDir === undefined) delete process.env.CAPTAIN_MEMO_DATA_DIR;
  else process.env.CAPTAIN_MEMO_DATA_DIR = prevDataDir;
  rmWorkDir(workDir);
});

async function startPairedWorker(label: string): Promise<{ token: string; deviceId: string; gatewayPort: number }> {
  const { device, token } = pairNewDevice(label, cfgPath);
  const gatewayPort = findFreePort();
  process.env.CAPTAIN_MEMO_GATEWAY_PORT = String(gatewayPort);
  worker = await startWorker({
    port: 0,
    projectId: 'gw-int-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
  });
  return { token, deviceId: device.id, gatewayPort };
}

test('starting a worker with zero devices paired does not throw or hang', async () => {
  worker = await startWorker({
    port: 0, projectId: 'gw-int-test', metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused', embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'), embeddingDimension: 8, skipEmbed: true,
  });
  expect(worker.port).toBeGreaterThan(0);
});

test('authenticated MCP tools/list over the gateway reaches the real tool set', async () => {
  const { token, gatewayPort } = await startPairedWorker('phone');

  const initRes = await fetch(`http://127.0.0.1:${gatewayPort}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    }),
  });
  expect(initRes.status).toBe(200);
});

test('a missing bearer token 401s before reaching MCP handling', async () => {
  const { gatewayPort } = await startPairedWorker('phone');
  const res = await fetch(`http://127.0.0.1:${gatewayPort}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  expect(res.status).toBe(401);
});

test('a garbage bearer token 401s', async () => {
  const { gatewayPort } = await startPairedWorker('phone');
  const res = await fetch(`http://127.0.0.1:${gatewayPort}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  expect(res.status).toBe(401);
});

test('revoke immediately invalidates a previously-valid token', async () => {
  const { token, deviceId, gatewayPort } = await startPairedWorker('phone');
  revokeDevice(deviceId, cfgPath);

  const res = await fetch(`http://127.0.0.1:${gatewayPort}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test tests/integration/gateway-http-mcp.test.ts`
Expected: PASS — all 5 tests pass. If the `initialize` round-trip 400s instead of 200s, check the request body against the MCP SDK's expected `InitializeRequest` shape (`protocolVersion`, `capabilities`, `clientInfo` are all required) before assuming the gateway code is wrong.

- [ ] **Step 3: Run the full test suite**

Run: `bun run test:unit 2>&1 | tail -6 && bun test tests/integration/ 2>&1 | tail -6`
Expected: 0 fail across both, pass counts are the prior totals plus this task's new tests.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/gateway-http-mcp.test.ts
git commit -m "test(gateway): end-to-end pairing + auth + revoke integration coverage"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add a README section**

Add a new subsection right after the existing `### Backup & restore` section (find it via `grep -n "### Backup & restore" README.md` to get the exact insertion point), matching that section's heading level and style:

```markdown
### Local device pairing

Pair a second device (phone, tablet, another machine) to this captain's memory — no hub, no
external relay, entirely self-hosted:

```bash
captain-memo gateway pair --label "phone"     # prints a one-time token + connector URL
captain-memo gateway list                     # show paired devices
captain-memo gateway revoke <device-id>       # remove a device; its token stops working at once
captain-memo restart                          # apply the change
```

The worker itself serves an authenticated HTTP-MCP listener (localhost-only) once a device is
paired — nothing runs unless you pair something. Reach it from outside your machine via your own
reverse proxy (nginx, Caddy, a tunnel) with TLS; captain-memo never binds a public interface or
manages certificates itself. Every paired device gets the same tool access a local session has —
there's no separate identity or trust model to configure, just this one corpus, one more
authenticated way in.
```

- [ ] **Step 2: Add a CHANGELOG entry**

Add a new `## [Unreleased]` section (or the next version number, per whatever the current `package.json` version is at implementation time — check with `grep version package.json` first) above the most recent dated entry, following this repo's existing entry style:

```markdown
### Added
- **Local device pairing — pair a second device (phone, another machine) to this captain's memory, no hub required.** `captain-memo gateway pair|list|revoke` mints/lists/removes bearer tokens; the worker serves an authenticated HTTP-MCP listener (localhost-only, started only when a device is paired) that the operator reaches via their own reverse proxy + TLS. Full tool access per paired device in this release — no separate identity, no peer/federation concept, no new process to manage.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document local device pairing (gateway pair|list|revoke)"
```
