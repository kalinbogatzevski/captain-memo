import { test, expect, beforeAll, afterAll } from 'bun:test';
import { Embedder } from '../../src/worker/embedder.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockServer: ReturnType<typeof Bun.serve>;
let mockPort: number;
let lastRequestBody: any = null;

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0,
    async fetch(req) {
      lastRequestBody = await req.json();
      const inputs = lastRequestBody.input as string[];
      const data = inputs.map((_, idx) => ({
        embedding: Array.from({ length: 8 }, (_, i) => idx * 8 + i),
        index: idx,
      }));
      return new Response(JSON.stringify({ data, model: 'voyage-4-nano' }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  mockPort = mockServer.port!;
});

afterAll(() => {
  mockServer.stop();
});

test('Embedder — embeds a single text', async () => {
  const embedder = new Embedder({
    endpoint: `http://localhost:${mockPort}/v1/embeddings`,
    model: 'voyage-4-nano',
    apiKey: 'test-key',
  });
  const result = await embedder.embed(['hello world']);
  expect(result).toHaveLength(1);
  expect(result[0]).toHaveLength(8);
  expect(lastRequestBody.input).toEqual(['hello world']);
  expect(lastRequestBody.model).toBe('voyage-4-nano');
});

test('Embedder — embeds multiple texts', async () => {
  const embedder = new Embedder({
    endpoint: `http://localhost:${mockPort}/v1/embeddings`,
    model: 'voyage-4-nano',
    apiKey: 'test-key',
  });
  const result = await embedder.embed(['a', 'b', 'c']);
  expect(result).toHaveLength(3);
});

test('Embedder — sends auth header when apiKey provided', async () => {
  let capturedAuth: string | null = null;
  const authServer = Bun.serve({
    port: 0,
    async fetch(req) {
      capturedAuth = req.headers.get('authorization');
      return new Response(JSON.stringify({ data: [{ embedding: [0], index: 0 }], model: 'x' }));
    },
  });
  const embedder = new Embedder({
    endpoint: `http://localhost:${authServer.port}/v1/embeddings`,
    model: 'voyage-4-nano',
    apiKey: 'secret-key',
  });
  await embedder.embed(['x']);
  expect(capturedAuth as unknown as string).toBe('Bearer secret-key');
  authServer.stop();
});

test('Embedder — retries on 5xx with exponential backoff', async () => {
  let callCount = 0;
  const flakyServer = Bun.serve({
    port: 0,
    async fetch() {
      callCount++;
      if (callCount < 3) {
        return new Response('server error', { status: 503 });
      }
      return new Response(JSON.stringify({
        data: [{ embedding: [1, 2, 3], index: 0 }],
        model: 'voyage-4-nano',
      }));
    },
  });
  const embedder = new Embedder({
    endpoint: `http://localhost:${flakyServer.port}/v1/embeddings`,
    model: 'voyage-4-nano',
    maxRetries: 3,
  });
  const result = await embedder.embed(['x']);
  expect(callCount).toBe(3);
  expect(result[0]).toEqual([1, 2, 3]);
  flakyServer.stop();
});

test('Embedder — gives up after maxRetries', async () => {
  const brokenServer = Bun.serve({
    port: 0,
    fetch: () => new Response('server error', { status: 503 }),
  });
  const embedder = new Embedder({
    endpoint: `http://localhost:${brokenServer.port}/v1/embeddings`,
    model: 'voyage-4-nano',
    maxRetries: 2,
  });
  await expect(embedder.embed(['x'])).rejects.toThrow(/HTTP 503/);
  brokenServer.stop();
});

test('Embedder — does NOT retry on 4xx', async () => {
  let callCount = 0;
  const fourFourServer = Bun.serve({
    port: 0,
    fetch() {
      callCount++;
      return new Response('bad request', { status: 400 });
    },
  });
  const embedder = new Embedder({
    endpoint: `http://localhost:${fourFourServer.port}/v1/embeddings`,
    model: 'voyage-4-nano',
    maxRetries: 5,
  });
  await expect(embedder.embed(['x'])).rejects.toThrow(/HTTP 400/);
  expect(callCount).toBe(1);
  fourFourServer.stop();
});
