import { test, expect, beforeAll, afterAll } from 'bun:test';
import { Embedder, EmbedderInputTooLarge } from '../../src/worker/embedder.ts';

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

test('Embedder — sends truncation:false in OpenAI-format body', async () => {
  const embedder = new Embedder({
    endpoint: `http://localhost:${mockPort}/v1/embeddings`,
    model: 'voyage-4-nano',
  });
  await embedder.embed(['hello']);
  // Voyage-specific guard: with truncation:false the API returns 422 on
  // overflow instead of silently embedding the first N tokens.
  expect(lastRequestBody.truncation).toBe(false);
});

test('Embedder — throws EmbedderInputTooLarge BEFORE calling API when input exceeds limit', async () => {
  let calls = 0;
  const countingServer = Bun.serve({
    port: 0,
    async fetch() {
      calls++;
      return new Response(JSON.stringify({ data: [{ embedding: [0], index: 0 }], model: 'x' }));
    },
  });
  const embedder = new Embedder({
    endpoint: `http://localhost:${countingServer.port}/v1/embeddings`,
    model: 'voyage-4-nano',
    maxInputTokens: 10, // tiny limit to force the throw on any non-trivial input
  });
  // ~50 tokens of repeated text — comfortably over the 10-token limit even
  // with the 0.85 safety factor (effective limit = 8 tokens).
  const oversized = 'the quick brown fox jumps over the lazy dog '.repeat(20);
  await expect(embedder.embed([oversized])).rejects.toBeInstanceOf(EmbedderInputTooLarge);
  expect(calls).toBe(0); // never hit the API — pre-call guard fired
  countingServer.stop();
});

test('Embedder — EmbedderInputTooLarge carries diagnostic fields', async () => {
  const embedder = new Embedder({
    endpoint: 'http://localhost:1/unused',
    model: 'voyage-4-nano',
    maxInputTokens: 5,
  });
  const oversized = 'one two three four five six seven eight nine ten eleven twelve';
  try {
    await embedder.embed(['ok', oversized, 'also ok']);
    throw new Error('expected throw');
  } catch (e) {
    expect(e).toBeInstanceOf(EmbedderInputTooLarge);
    const err = e as EmbedderInputTooLarge;
    expect(err.tokensLimit).toBe(5);
    expect(err.tokensEstimated).toBeGreaterThan(5);
    expect(err.inputIndex).toBe(1); // 0='ok', 1=oversized, 2='also ok'
  }
});

test('Embedder — without maxInputTokens, oversized input is sent to API (legacy behavior)', async () => {
  let captured: string | null = null;
  const passthroughServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as { input: string[] };
      captured = body.input[0]!;
      return new Response(JSON.stringify({ data: [{ embedding: [0], index: 0 }], model: 'x' }));
    },
  });
  const embedder = new Embedder({
    endpoint: `http://localhost:${passthroughServer.port}/v1/embeddings`,
    model: 'voyage-4-nano',
    // maxInputTokens NOT set
  });
  const longText = 'word '.repeat(1000);
  await embedder.embed([longText]);
  expect(captured as unknown as string).toBe(longText); // sent through unchecked
  passthroughServer.stop();
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
