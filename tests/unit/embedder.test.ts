import { test, expect, beforeAll, afterAll, spyOn, setSystemTime } from 'bun:test';
import {
  Embedder, EmbedderInputTooLarge, EmbedderPaused, EmbedderBudgetExceeded, makeUsageReporter,
  INTERACTIVE_BUDGET_TOKENS, TAIL_MINUTES, RING_MINUTES, type EmbedUsage,
} from '../../src/worker/embedder.ts';
import { countTokens } from '../../src/shared/tokens.ts';

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

// ---- per-minute metering and the interactive token budget (2026-10-22, #960) ----
// The clock is moved with setSystemTime (the embedder reads Date.now()); every test puts it back.
const TEXT = 'alpha beta gamma delta epsilon zeta eta theta';
const TOK = countTokens(TEXT);
const T0 = Date.UTC(2026, 9, 22, 10, 0, 10);                  // 10 s into a minute, so a slow test never crosses one
const MIN0 = Math.floor(T0 / 60_000) * 60;                    // that minute, in epoch seconds
const clock = (ms: number): void => { setSystemTime(new Date(ms)); };
const quiet = () => spyOn(console, 'error').mockImplementation(() => {});
const budgetLines = (log: ReturnType<typeof quiet>): number => log.mock.calls.filter(c => String(c[0]).includes('interactive token budget')).length;

test('metering — each request lands in its minute and column; a later minute starts a new entry', async () => {
  const s = slowServer(); const e = new Embedder({ endpoint: s.url, model: 'x' });
  try {
    clock(T0);
    await e.embed([TEXT], 'query');
    await e.embed([TEXT, TEXT], 'document', { source: 'remember' });
    await e.embed([TEXT], 'document', { source: 'worknote' });
    await e.embed([TEXT], 'document', { source: 'ingest', patient: true });
    await e.embed([TEXT], 'document');                                   // no source: 'other'
    expect(e.usage().per_minute).toEqual([{ at_epoch: MIN0, by_source: {
      query: { calls: 1, tokens: TOK }, remember: { calls: 1, tokens: 2 * TOK }, worknote: { calls: 1, tokens: TOK },
      other: { calls: 2, tokens: 2 * TOK },                              // ingest and the unnamed one, together
    } }]);
    clock(T0 + 60_000);
    await e.embed([TEXT], 'query');
    const tail = e.usage().per_minute!;
    expect(tail.map(m => m.at_epoch)).toEqual([MIN0, MIN0 + 60]);       // oldest first
    expect(tail[1]!.by_source).toEqual({ query: { calls: 1, tokens: TOK } });   // sources that sent nothing are absent
  } finally { setSystemTime(); s.server.stop(); }
});

test('metering — the tail is the last TAIL_MINUTES, the hour is RING_MINUTES, a reused slot starts from zero', async () => {
  const s = slowServer(); const e = new Embedder({ endpoint: s.url, model: 'x' });
  try {
    for (let k = 0; k <= TAIL_MINUTES; k++) { clock(T0 + k * 60_000); await e.embed([TEXT], 'query'); }   // TAIL_MINUTES + 1 minutes
    const tail = e.usage().per_minute!;
    expect(tail).toHaveLength(TAIL_MINUTES);
    expect(tail[0]!.at_epoch).toBe(MIN0 + 60);                           // the first minute has dropped off the tail
    expect(e.usage().interactive_budget!.window_tokens).toBe((TAIL_MINUTES + 1) * TOK);   // but is still in the hour
    // RING_MINUTES later the first minute's slot is the one this request lands in: it must not add to the old count.
    clock(T0 + RING_MINUTES * 60_000);
    await e.embed([TEXT], 'query');
    expect(e.usage().per_minute!.at(-1)).toEqual({ at_epoch: MIN0 + RING_MINUTES * 60, by_source: { query: { calls: 1, tokens: TOK } } });
    // the hour is this minute and the 59 before it: minutes 1..TAIL_MINUTES are in, minute 0 is out
    expect(e.usage().interactive_budget!.window_tokens).toBe((TAIL_MINUTES + 1) * TOK);
  } finally { setSystemTime(); s.server.stop(); }
});

test('metering — the busiest interactive minute is tracked; patient work does not count towards it', async () => {
  const s = slowServer(); const e = new Embedder({ endpoint: s.url, model: 'x' });
  try {
    expect(e.usage().busiest_interactive_minute).toBeNull();
    clock(T0);
    await e.embed([TEXT], 'query'); await e.embed([TEXT], 'query');
    clock(T0 + 60_000);
    await e.embed(Array(20).fill(TEXT), 'document', { source: 'ingest', patient: true });   // a huge patient minute, then ...
    await e.embed([TEXT], 'query');                                                          // ... one interactive request in it
    expect(e.usage().busiest_interactive_minute).toEqual({ at_epoch: MIN0, calls: 2, tokens: 2 * TOK });
  } finally { setSystemTime(); s.server.stop(); }
});

test('metering — a quiet engine reports the same snapshot tick after tick, so its reader stops posting', async () => {
  const s = slowServer(); const e = new Embedder({ endpoint: s.url, model: 'x' });
  const posts: EmbedUsage[] = [];
  const reporter = makeUsageReporter(() => e.usage(), (u) => posts.push(u));
  try {
    clock(T0);
    reporter.tick();
    expect(posts).toHaveLength(0);                                       // nothing sent yet
    await e.embed([TEXT], 'query');
    reporter.tick(); reporter.tick(); reporter.tick();
    expect(posts).toHaveLength(1);
    clock(T0 + 3 * 60_000); reporter.tick(); reporter.tick();            // still inside the tail: nothing moved
    expect(posts).toHaveLength(1);
    clock(T0 + (TAIL_MINUTES + 1) * 60_000); reporter.tick();            // the minute leaves the tail: one more post
    expect(posts).toHaveLength(2);
    expect(posts.at(-1)!.per_minute).toEqual([]);
    clock(T0 + 30 * 60_000); reporter.tick(); reporter.tick();           // nothing changes while the spend is in the hour
    expect(posts).toHaveLength(2);
    clock(T0 + (RING_MINUTES + 1) * 60_000); reporter.tick(); reporter.tick();   // it leaves the hour: one more, then quiet for good
    expect(posts).toHaveLength(3);
    expect(posts.at(-1)!.interactive_budget!.window_tokens).toBe(0);
  } finally { setSystemTime(); s.server.stop(); }
});

test('budget — only the interactive sources count; the request that reaches the limit is sent, the next one is not', async () => {
  const s = slowServer(); const e = new Embedder({ endpoint: s.url, model: 'x', interactiveBudgetTokens: 3 * TOK });
  const log = quiet();
  try {
    await e.embed(Array(10).fill(TEXT), 'document', { source: 'ingest', patient: true });
    await e.embed([TEXT], 'document', { source: 'pending-retry', patient: true });
    await e.embed([TEXT], 'document');                                   // the unnamed 'other' (the boot probe's)
    expect(e.usage().interactive_budget).toMatchObject({ limit_tokens: 3 * TOK, window_tokens: 0, trips: 0 });
    await e.embed([TEXT], 'query');
    await e.embed([TEXT], 'document', { source: 'remember' });
    expect(e.usage().interactive_budget).toMatchObject({ window_tokens: 2 * TOK, paused_until_epoch: null, trips: 0 });
    expect(e.budgetPausedUntilMs()).toBe(0);                             // 2 of 3: not before the limit
    const sent = s.state.requests;
    await e.embed([TEXT], 'document', { source: 'worknote' });           // exactly the limit: sent ...
    expect(s.state.requests).toBe(sent + 1);
    expect(e.budgetPausedUntilMs()).toBeGreaterThan(0);                  // ... and it trips
    expect(e.usage().interactive_budget).toMatchObject({ window_tokens: 3 * TOK, trips: 1 });
    expect(e.usage().interactive_budget!.paused_until_epoch).not.toBeNull();
    for (const call of [() => e.embed([TEXT], 'query'), () => e.embed([TEXT], 'document', { source: 'remember' }), () => e.embed([TEXT], 'document', { source: 'worknote' })]) {
      await expect(call()).rejects.toBeInstanceOf(EmbedderBudgetExceeded);
    }
    expect(s.state.requests).toBe(sent + 1);                             // refused before anything was sent
    await e.embed([TEXT], 'document', { source: 'ingest', patient: true });   // indexing carries on
    expect(s.state.requests).toBe(sent + 2);
    expect(budgetLines(log)).toBe(1);                                    // one log line for the trip, not one per refusal
    // the waste pause is a different thing and says nothing here
    expect(e.pausedUntilMs()).toBe(0);
    expect(e.usage().paused_until_epoch).toBeNull();
    expect(e.degradationFlags()).toHaveLength(1);
    expect(e.degradationFlags()[0]).toStartWith('embedder=paused:interactive-token-budget:until=');
  } finally { log.mockRestore(); s.server.stop(); }
});

test('budget — one token under the limit does not trip', async () => {
  const s = slowServer(); const e = new Embedder({ endpoint: s.url, model: 'x', interactiveBudgetTokens: 3 * TOK + 1 });
  const log = quiet();
  try {
    for (let i = 0; i < 3; i++) await e.embed([TEXT], 'query');
    expect(e.budgetPausedUntilMs()).toBe(0);
    expect(e.degradationFlags()).toEqual([]);
    await e.embed([TEXT], 'query');                                      // the fourth reaches it
    expect(e.budgetPausedUntilMs()).toBeGreaterThan(0);
  } finally { log.mockRestore(); s.server.stop(); }
});

test('budget — tokens count whether or not the request was answered, every retry included', async () => {
  const down = slowServer({ status: 503 });
  const a = new Embedder({ endpoint: down.url, model: 'x', maxRetries: 3, wasteLimitTokens: 0, interactiveBudgetTokens: 100 * TOK });
  await expect(a.embed([TEXT], 'query')).rejects.toThrow(/HTTP 503/);
  expect(down.state.requests).toBe(3);
  expect(a.usage().interactive_budget!.window_tokens).toBe(3 * TOK);     // each attempt is a request the provider may bill
  down.server.stop();
  const refused = slowServer({ status: 401 });
  const b = new Embedder({ endpoint: refused.url, model: 'x', wasteLimitTokens: 0, interactiveBudgetTokens: 100 * TOK });
  await expect(b.embed([TEXT], 'query')).rejects.toThrow(/HTTP 401/);
  expect(b.usage().wasted_tokens).toBe(0);                               // not waste ...
  expect(b.usage().interactive_budget!.window_tokens).toBe(TOK);         // ... but sent
  refused.server.stop();
});

test('budget — a retry after the attempt that used the budget up is not sent', async () => {
  const down = slowServer({ status: 503 });
  const e = new Embedder({ endpoint: down.url, model: 'x', maxRetries: 3, wasteLimitTokens: 0, interactiveBudgetTokens: TOK });
  const log = quiet();
  try {
    await expect(e.embed([TEXT], 'query')).rejects.toBeInstanceOf(EmbedderBudgetExceeded);   // not "HTTP 503"
    expect(down.state.requests).toBe(1);                                 // it used to be 3
  } finally { log.mockRestore(); down.server.stop(); }
});

test('budget — the pause ends on time but the hour still holds the spend, so it trips again; embedding resumes when the spend leaves the hour', async () => {
  const s = slowServer(); const e = new Embedder({ endpoint: s.url, model: 'x', interactiveBudgetTokens: TOK });
  const log = quiet();
  try {
    clock(T0);
    await e.embed([TEXT], 'query');                                      // reaches the limit: trip 1, pause 30 minutes
    expect(e.usage().interactive_budget!.trips).toBe(1);
    clock(T0 + 29 * 60_000);
    await expect(e.embed([TEXT], 'query')).rejects.toBeInstanceOf(EmbedderBudgetExceeded);
    expect(e.usage().interactive_budget!.trips).toBe(1);                 // same trip, no second log line
    clock(T0 + 31 * 60_000);                                             // pause over; the spend is 31 minutes old
    await expect(e.embed([TEXT], 'query')).rejects.toBeInstanceOf(EmbedderBudgetExceeded);
    expect(e.usage().interactive_budget!.trips).toBe(2);                 // not a fresh budget: a new trip
    expect(s.state.requests).toBe(1);
    clock(T0 + 62 * 60_000);                                             // the spend is out of the hour
    await e.embed([TEXT], 'query');
    expect(s.state.requests).toBe(2);
    expect(e.usage().interactive_budget).toMatchObject({ trips: 3, window_tokens: TOK });   // this one alone is the whole limit: a third trip
    expect(budgetLines(log)).toBe(3);                                    // one log line per trip
  } finally { setSystemTime(); log.mockRestore(); s.server.stop(); }
});

test('budget — 0 turns it off but the minutes are still counted; the default is INTERACTIVE_BUDGET_TOKENS', async () => {
  const s = slowServer();
  const off = new Embedder({ endpoint: s.url, model: 'x', interactiveBudgetTokens: 0 });
  for (let i = 0; i < 5; i++) await off.embed([TEXT.repeat(50)], 'query');
  expect(off.budgetPausedUntilMs()).toBe(0);
  expect(off.usage().interactive_budget).toMatchObject({ limit_tokens: 0, trips: 0 });
  expect(off.usage().interactive_budget!.window_tokens).toBeGreaterThan(0);
  expect(new Embedder({ endpoint: s.url, model: 'x' }).usage().interactive_budget!.limit_tokens).toBe(INTERACTIVE_BUDGET_TOKENS);
  s.server.stop();
});

test('degradationFlags — empty when healthy; the waste pause has its own entry', async () => {
  const s = slowServer({ delayMs: 300 });
  const e = new Embedder({ endpoint: s.url, model: 'x', timeoutMs: 40, wasteLimitTokens: 1, pauseMs: 5000 });
  expect(e.degradationFlags()).toEqual([]);
  await expect(e.embed(['some text'])).rejects.toThrow();                // wasted -> paused
  const flags = e.degradationFlags();
  expect(flags).toHaveLength(1);
  expect(flags[0]).toStartWith('embedder=paused:wasted-tokens:until=');
  s.server.stop();
});
