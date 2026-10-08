import { test, expect, beforeAll, afterAll } from 'bun:test';
import { Embedder, EmbedderInputTooLarge, EmbedderPaused } from '../../src/worker/embedder.ts';

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

// ---- spend metering, timeouts and the waste pause (2026-10-08) ----
// A server whose answer can be delayed or refused, counting what reaches it.
function slowServer(opts: { delayMs?: number; status?: number } = {}) {
  const state = { requests: 0, delayMs: opts.delayMs ?? 0, status: opts.status ?? 200 };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      state.requests++;
      const body = await req.json() as { input: string[] };
      if (state.delayMs) await new Promise(r => setTimeout(r, state.delayMs));
      if (state.status !== 200) return new Response('{"detail":"nope"}', { status: state.status });
      return new Response(JSON.stringify({ data: body.input.map((_, i) => ({ embedding: [1, 2], index: i })), model: 'x' }));
    },
  });
  return { state, server, url: `http://localhost:${server.port}/v1/embeddings` };
}

test('Embedder — usage counts requests, tokens and the source of each call', async () => {
  const s = slowServer();
  const e = new Embedder({ endpoint: s.url, model: 'x' });
  await e.embed(['hello world', 'second text'], 'document', { source: 'ingest' });
  await e.embed(['a question'], 'query');
  const u = e.usage();
  s.server.stop();
  expect(u.calls).toBe(2);
  expect(u.tokens).toBeGreaterThan(4);
  expect(u.by_source.ingest!.calls).toBe(1);
  expect(u.by_source.query!.calls).toBe(1);
  expect(u.wasted_tokens).toBe(0);
});

test('Embedder — a request cut off by our own timeout is NOT sent again, and its tokens count as wasted', async () => {
  const s = slowServer({ delayMs: 300 });
  const e = new Embedder({ endpoint: s.url, model: 'x', timeoutMs: 50, wasteLimitTokens: 0 });
  await expect(e.embed(['some text to embed'])).rejects.toThrow();
  const u = e.usage();
  s.server.stop();
  expect(s.state.requests).toBe(1);    // it used to be 3: the same batch, billed three times
  expect(u.aborted).toBe(1);
  expect(u.wasted_tokens).toBe(u.tokens);
});

test('Embedder — a patient call gets the long timeout, an interactive one the short', async () => {
  const s = slowServer({ delayMs: 150 });
  const e = new Embedder({ endpoint: s.url, model: 'x', timeoutMs: 50, patientTimeoutMs: 2000, wasteLimitTokens: 0 });
  await expect(e.embed(['x'])).rejects.toThrow();
  const out = await e.embed(['x'], 'document', { patient: true });
  s.server.stop();
  expect(out).toHaveLength(1);
});

test('Embedder — a 4xx wastes nothing, a 5xx does and is still retried', async () => {
  const refused = slowServer({ status: 401 });
  const a = new Embedder({ endpoint: refused.url, model: 'x', wasteLimitTokens: 0 });
  await expect(a.embed(['x'])).rejects.toThrow(/HTTP 401/);
  refused.server.stop();
  expect(a.usage().wasted_tokens).toBe(0);

  const down = slowServer({ status: 503 });
  const b = new Embedder({ endpoint: down.url, model: 'x', maxRetries: 2, wasteLimitTokens: 0 });
  await expect(b.embed(['x'])).rejects.toThrow(/HTTP 503/);
  down.server.stop();
  expect(down.state.requests).toBe(2);
  expect(b.usage().wasted_tokens).toBe(b.usage().tokens);
});

test('Embedder — too many wasted tokens pause it: nothing is sent, then one probe ends the pause', async () => {
  const s = slowServer({ delayMs: 300 });
  const e = new Embedder({ endpoint: s.url, model: 'x', timeoutMs: 40, wasteLimitTokens: 1, pauseMs: 150 });
  await expect(e.embed(['some text'])).rejects.toThrow();            // wasted -> paused
  expect(e.pausedUntilMs()).toBeGreaterThan(0);
  expect(e.usage().paused_until_epoch).not.toBeNull();
  const before = s.state.requests;
  await expect(e.embed(['some text'])).rejects.toBeInstanceOf(EmbedderPaused);
  expect(s.state.requests).toBe(before);                              // not even a request
  await new Promise(r => setTimeout(r, 200));                         // pause over
  s.state.delayMs = 0;
  await e.embed(['some text']);                                       // the probe is answered
  expect(e.pausedUntilMs()).toBe(0);
  expect(e.usage().window_wasted_tokens).toBe(0);
  s.server.stop();
});

test('Embedder — a probe that is wasted too starts the pause again', async () => {
  const s = slowServer({ delayMs: 300 });
  const e = new Embedder({ endpoint: s.url, model: 'x', timeoutMs: 40, wasteLimitTokens: 1, pauseMs: 100 });
  await expect(e.embed(['some text'])).rejects.toThrow();
  await new Promise(r => setTimeout(r, 130));
  await expect(e.embed(['some text'])).rejects.not.toBeInstanceOf(EmbedderPaused);   // the probe went out
  expect(e.pausedUntilMs()).toBeGreaterThan(0);                                      // and paused it again
  s.server.stop();
});

test('Embedder — a refused connection wastes nothing: the request never left', async () => {
  // Port 1 is never listening; a port a stopped server just freed can be taken by another test in a full run.
  const e = new Embedder({ endpoint: 'http://localhost:1/v1/embeddings', model: 'x', wasteLimitTokens: 1 });
  await expect(e.embed(['some text'])).rejects.toThrow();
  expect(e.usage().wasted_tokens).toBe(0);
  expect(e.pausedUntilMs()).toBe(0);
});
