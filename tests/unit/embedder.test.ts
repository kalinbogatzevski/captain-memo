import { test, expect, beforeAll, afterAll } from 'bun:test';
import { VoyageEmbedder } from '../../src/worker/embedder.ts';

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

test('VoyageEmbedder — embeds a single text', async () => {
  const embedder = new VoyageEmbedder({
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

test('VoyageEmbedder — embeds multiple texts', async () => {
  const embedder = new VoyageEmbedder({
    endpoint: `http://localhost:${mockPort}/v1/embeddings`,
    model: 'voyage-4-nano',
    apiKey: 'test-key',
  });
  const result = await embedder.embed(['a', 'b', 'c']);
  expect(result).toHaveLength(3);
});

test('VoyageEmbedder — sends auth header when apiKey provided', async () => {
  let capturedAuth: string | null = null;
  const authServer = Bun.serve({
    port: 0,
    async fetch(req) {
      capturedAuth = req.headers.get('authorization');
      return new Response(JSON.stringify({ data: [{ embedding: [0], index: 0 }], model: 'x' }));
    },
  });
  const embedder = new VoyageEmbedder({
    endpoint: `http://localhost:${authServer.port}/v1/embeddings`,
    model: 'voyage-4-nano',
    apiKey: 'secret-key',
  });
  await embedder.embed(['x']);
  expect(capturedAuth as unknown as string).toBe('Bearer secret-key');
  authServer.stop();
});
