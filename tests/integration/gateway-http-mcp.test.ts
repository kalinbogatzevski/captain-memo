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
