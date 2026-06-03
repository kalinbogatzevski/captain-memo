import { test, expect } from 'bun:test';
import { serializeRequest, deserializeRequest, serializeResponse, deserializeResponse } from '../../../src/worker/request-serde.ts';

test('GET request round-trips (no body)', async () => {
  const wire = await serializeRequest(new Request('http://localhost:39888/stats', { method: 'GET' }));
  const req = deserializeRequest(wire);
  expect(req.method).toBe('GET');
  expect(new URL(req.url).pathname).toBe('/stats');
});

test('POST request round-trips body + json()', async () => {
  const wire = await serializeRequest(new Request('http://localhost:39888/search/all', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x', top_k: 5 }),
  }));
  const req = deserializeRequest(wire);
  expect(req.method).toBe('POST');
  expect(await req.json()).toEqual({ query: 'x', top_k: 5 });
});

test('JSON response round-trips status + body', async () => {
  const wire = await serializeResponse(Response.json({ healthy: true }, { status: 200 }));
  const res = deserializeResponse(wire);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ healthy: true });
});
