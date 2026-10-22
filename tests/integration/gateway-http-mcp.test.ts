import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
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

test('a session survives across multiple requests (initialize, then tools/list, then tools/call)', async () => {
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
  const sessionId = initRes.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();

  // Second request on the SAME session — this is exactly what broke before the fix
  // (every prior request built a fresh Server/Transport, so a second request always
  // 400'd "Server not initialized"). Must succeed now.
  const listRes = await fetch(`http://127.0.0.1:${gatewayPort}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'mcp-session-id': sessionId!,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  expect(listRes.status).toBe(200);

  // Third request, same session again — confirms it's not just "survives once."
  const listRes2 = await fetch(`http://127.0.0.1:${gatewayPort}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'mcp-session-id': sessionId!,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
  });
  expect(listRes2.status).toBe(200);
});

test('an unknown session id 404s (does not silently create a new session)', async () => {
  const { gatewayPort } = await startPairedWorker('phone');
  const res = await fetch(`http://127.0.0.1:${gatewayPort}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-session-id': 'totally-made-up-session-id',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  expect(res.status).toBe(404);
});

// ── Session-id is not a credential (#965) ───────────────────────────────────────────────────────
// The bearer used to be checked on `initialize` only; every later request was routed on the
// `mcp-session-id` header alone, so a leaked session id (reverse-proxy access log, a debug capture)
// was a bearer-equivalent credential that revoke could not end. Real worker, real gateway port.

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

function rpc(id: number, method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

async function openSession(gatewayPort: number, token: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${gatewayPort}/`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, authorization: `Bearer ${token}` },
    body: rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('mcp-session-id')!;
}

function onSession(gatewayPort: number, sid: string, extra: Record<string, string>, body = rpc(2, 'tools/list')): Promise<Response> {
  return fetch(`http://127.0.0.1:${gatewayPort}/`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, 'mcp-session-id': sid, ...extra },
    body,
  });
}

test('a known session id with NO bearer is refused — the id alone cannot run tools', async () => {
  const { token, gatewayPort } = await startPairedWorker('phone');
  const sid = await openSession(gatewayPort, token);
  // The exploit: a tool call carrying only the leaked id.
  const res = await onSession(gatewayPort, sid, {}, rpc(2, 'tools/call', { name: 'stats', arguments: {} }));
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: 'unauthorized' });
});

test('a known session id with the bearer of ANOTHER paired device is refused — not transferable', async () => {
  const { token, gatewayPort } = await startPairedWorker('phone');
  const other = pairNewDevice('laptop', cfgPath); // gateway re-reads gateway.json per request
  const sid = await openSession(gatewayPort, token);
  const res = await onSession(gatewayPort, sid, { authorization: `Bearer ${other.token}` });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'session/device mismatch' });
});

test('a known session id with a garbage bearer is refused', async () => {
  const { token, gatewayPort } = await startPairedWorker('phone');
  const sid = await openSession(gatewayPort, token);
  const res = await onSession(gatewayPort, sid, { authorization: 'Bearer not-a-real-token' });
  expect(res.status).toBe(401);
});

test('revoking a device ends its OPEN sessions at once, even with its old bearer', async () => {
  const { token, deviceId, gatewayPort } = await startPairedWorker('phone');
  const sid = await openSession(gatewayPort, token);
  expect((await onSession(gatewayPort, sid, { authorization: `Bearer ${token}` })).status).toBe(200);
  revokeDevice(deviceId, cfgPath);
  expect((await onSession(gatewayPort, sid, { authorization: `Bearer ${token}` })).status).toBe(401);
  expect((await onSession(gatewayPort, sid, {})).status).toBe(401);
});

test('the session owner presenting its own bearer still works on the same session', async () => {
  const { token, gatewayPort } = await startPairedWorker('phone');
  const sid = await openSession(gatewayPort, token);
  const res = await onSession(gatewayPort, sid, { authorization: `Bearer ${token}` });
  expect(res.status).toBe(200);
});

test('an unauthenticated DELETE cannot terminate someone else\'s session', async () => {
  const { token, gatewayPort } = await startPairedWorker('phone');
  const sid = await openSession(gatewayPort, token);
  const del = await fetch(`http://127.0.0.1:${gatewayPort}/`, { method: 'DELETE', headers: { 'mcp-session-id': sid } });
  expect(del.status).toBe(401);
  expect((await onSession(gatewayPort, sid, { authorization: `Bearer ${token}` })).status).toBe(200);
});

test('an unauthenticated GET (SSE stream) on a known session id is refused', async () => {
  const { token, gatewayPort } = await startPairedWorker('phone');
  const sid = await openSession(gatewayPort, token);
  const res = await fetch(`http://127.0.0.1:${gatewayPort}/`, {
    method: 'GET',
    headers: { accept: 'text/event-stream', 'mcp-session-id': sid },
    signal: AbortSignal.timeout(5000), // an accepted GET holds the stream open; never hang the suite on it
  });
  await res.body?.cancel();
  expect(res.status).toBe(401);
});

test('the MCP SDK client (bearer in requestInit) works end to end — no regression for a legitimate client', async () => {
  const { token, gatewayPort } = await startPairedWorker('phone');
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'sdk-test', version: '0' }, { capabilities: {} });
  try {
    await client.connect(transport as Transport); // initialize + notifications/initialized + the GET stream attempt
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    expect((await client.callTool({ name: 'stats', arguments: {} })).content).toBeDefined();
    await transport.terminateSession(); // DELETE
  } finally {
    await client.close();
  }
});
