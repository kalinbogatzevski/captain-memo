import { test, expect, afterAll } from 'bun:test';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { countTokens } from '../../src/shared/tokens.ts';

// The interactive embed budget (#960): when an engine has used its hour up, a search is answered from keywords alone and
// used to say nothing. Every search route must now carry the reason in degradation_flags (the MCP tools hand the body to
// the AI unchanged), and must NOT carry anything before that. Here a real worker, a stand-in provider, a budget that the
// third query reaches.
const DIM = 8;
const QUERY = 'where is the embed budget kept';
const TOK = countTokens(QUERY);
const FLAG = 'embedder=paused:interactive-token-budget:until=';
const ENV = 'CAPTAIN_MEMO_EMBEDDER_INTERACTIVE_BUDGET_TOKENS';

const servers: Array<{ stop: (f?: boolean) => void }> = [];
const workers: WorkerHandle[] = [];
afterAll(async () => {
  for (const w of workers) await w.stop();
  for (const s of servers) s.stop(true);
});

type BudgetStats = { embedder_usage: { interactive_budget: { limit_tokens: number; trips: number; paused_until_epoch: number | null; window_tokens: number }; per_minute: unknown[] } };

async function boot(budgetEnv: string): Promise<{ post: (path: string, body: unknown) => Promise<Record<string, unknown>>; provider: { queries: number }; stats: (ready: (s: BudgetStats) => boolean) => Promise<BudgetStats> }> {
  const provider = { queries: 0 };
  const fake = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const b = await req.json() as { input: string[]; input_type?: string };
      if (b.input_type === 'query') provider.queries += 1;
      return Response.json({ data: b.input.map((_, i) => ({ embedding: Array.from({ length: DIM }, (_, k) => (k === i % DIM ? 1 : 0.1)), index: i })), model: 'stand-in' });
    },
  });
  servers.push(fake);
  const before = process.env[ENV];
  process.env[ENV] = budgetEnv;                          // read once, when the worker builds its embedder
  let worker: WorkerHandle;
  try {
    worker = await startWorker({
      port: 0, projectId: 'budget-test', metaDbPath: ':memory:', vectorDbPath: ':memory:', embeddingDimension: DIM,
      embedderEndpoint: `http://localhost:${fake.port}/v1/embeddings`, embedderModel: 'stand-in', skipEmbed: false,
    });
  } finally {
    if (before === undefined) delete process.env[ENV]; else process.env[ENV] = before;
  }
  workers.push(worker);
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`http://localhost:${worker.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    return await res.json() as Record<string, unknown>;
  };
  // /stats is cached for 5 s: read it until it shows what the test is waiting for.
  const stats = async (ready: (s: BudgetStats) => boolean): Promise<BudgetStats> => {
    const end = Date.now() + 10_000;
    for (;;) {
      const s = await (await fetch(`http://localhost:${worker.port}/stats`)).json() as BudgetStats;
      if (ready(s) || Date.now() > end) return s;
      await Bun.sleep(250);
    }
  };
  return { post, provider, stats };
}

test('every search route says so once the budget is used up, and says nothing before', async () => {
  // Two queries fit (2 x TOK < limit); the third reaches the limit, is sent, and trips it.
  const { post, provider, stats: readStats } = await boot(String(2 * TOK + 1));

  const all = await post('/search/all', { query: QUERY, top_k: 3 });
  expect('degradation_flags' in all).toBe(false);                             // no key on a healthy search, as before
  const memory = await post('/search/memory', { query: QUERY, top_k: 3 });
  expect('degradation_flags' in memory).toBe(false);                          // the others did not have it: still do not
  expect(provider.queries).toBe(2);

  const skill = await post('/search/skill', { query: QUERY, top_k: 3 });      // the one that reaches the limit
  expect(provider.queries).toBe(3);                                           // it was embedded ...

  // ... and the state is already true on its response. From then on queries are refused before they are sent (the
  // provider sees no fourth), and every route carries the flag, exactly once. Every route that fails to is named in the
  // one failure message below.
  const unflagged: string[] = [];
  const check = (path: string, body: Record<string, unknown>): void => {
    const flags = (body.degradation_flags ?? []) as string[];
    if (flags.length !== 1 || !flags[0]!.startsWith(FLAG)) unflagged.push(path);
  };
  check('/search/skill (the request that used it up)', skill);
  const routes: Array<[string, unknown]> = [
    ['/search/all', { query: QUERY, top_k: 3 }],
    ['/search/memory', { query: QUERY, top_k: 3 }],
    ['/search/skill', { query: QUERY, top_k: 3 }],
    ['/search/observations', { query: QUERY, top_k: 3 }],
    ['/skills/recommend', { task: QUERY }],
    ['/capabilities/recommend', { task: QUERY }],
  ];
  for (const [path, body] of routes) check(path, await post(path, body));
  const inject = ((await post('/inject/context', { prompt: `${QUERY} and a bit more so it is not short` })).degradation_flags ?? []) as string[];
  // what it said before (the keyword fallback) and now the reason
  if (!inject.includes('embedder=voyage:keyword-fallback=true') || !inject.some(f => f.startsWith(FLAG))) unflagged.push('/inject/context');
  expect(unflagged).toEqual([]);
  expect(provider.queries).toBe(3);                                           // nothing was sent after the budget ran out

  // /stats shows it too (the writer is this engine in a standalone worker).
  const stats = await readStats(s => s.embedder_usage?.interactive_budget?.trips === 1);
  expect(stats.embedder_usage.interactive_budget).toMatchObject({ limit_tokens: 2 * TOK + 1, trips: 1 });
  expect(stats.embedder_usage.interactive_budget.paused_until_epoch).not.toBeNull();
  expect(stats.embedder_usage.interactive_budget.window_tokens).toBeGreaterThanOrEqual(3 * TOK);
  expect(stats.embedder_usage.per_minute.length).toBeGreaterThanOrEqual(1);
}, 60_000);

test('with the budget switched off by the environment (0) nothing is ever flagged and /stats says so', async () => {
  const { post, provider, stats: readStats } = await boot('0');
  for (let i = 0; i < 5; i++) {
    const r = await post('/search/skill', { query: QUERY, top_k: 3 });
    expect('degradation_flags' in r).toBe(false);
  }
  expect(provider.queries).toBe(5);
  const stats = await readStats(s => (s.embedder_usage?.interactive_budget?.window_tokens ?? 0) >= 5 * TOK);
  expect(stats.embedder_usage.interactive_budget).toMatchObject({ limit_tokens: 0, trips: 0 });
  expect(stats.embedder_usage.interactive_budget.window_tokens).toBeGreaterThanOrEqual(5 * TOK);   // still metered
}, 60_000);
