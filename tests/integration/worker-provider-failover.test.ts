// tests/integration/worker-provider-failover.test.ts — RUNTIME summarizer provider failover.
//
// fed-v0.40.0 probes the provider chain at boot and commits for the worker's lifetime. This is the
// follow-on: a provider that dies mid-lifetime (the OAuth token that expires at hour 30) is retired
// and the next entry takes over, WITHOUT dead-lettering the observations it failed on.
//
// The four properties that make it safe, plus the one that keeps it from over-reacting:
//   1. auth-shaped permanent → demote → the batch is requeued → the next provider summarizes it
//   2. chain exhausted       → dead-letter, exactly as before the feature existed (regression guard)
//   3. a demoted provider is NEVER re-selected (no cooldown, no re-promotion, no flapping)
//   4. /remember's generate follows the swap (the boot-captured-transport trap)
//   5. a NON-auth permanent (400) does NOT demote on the first batch — only a run of them does
import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { startWorker, type WorkerHandle, type WorkerOptions, type SummarizerResult } from '../../src/worker/index.ts';
import type { SummarizerTransport } from '../../src/worker/summarizer.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

let worker: WorkerHandle | null = null;
let workDir = '';

async function boot(over: Partial<WorkerOptions>): Promise<number> {
  workDir = mkdtempSync(join(tmpdir(), 'cm-failover-'));
  worker = await startWorker({
    port: 0,
    projectId: 'failover-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    observationQueueDbPath: join(workDir, 'queue.db'),
    observationsDbPath: join(workDir, 'obs.db'),
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    observationTickMs: 0,   // no auto-tick; every test drives flush explicitly
    ...over,
  });
  return worker.port;
}

afterEach(async () => {
  if (worker) { try { await worker.stop(); } catch { /* best-effort */ } }
  worker = null;
  rmWorkDir(workDir);
});

/** One queued event in its own (session, prompt) group — i.e. one summarize() call. */
async function enqueue(port: number, session: string, prompt = 1): Promise<void> {
  const res = await fetch(`http://localhost:${port}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: session, project_id: 'p1', prompt_number: prompt,
      tool_name: 'Edit', tool_input_summary: 'edit foo.ts', tool_result_summary: 'ok',
      files_read: [], files_modified: ['foo.ts'], ts_epoch: 1_700_000_000,
    }),
  });
  expect(res.status).toBe(200);
}

async function flush(port: number, session: string): Promise<{ processed: number; observations_created: number }> {
  const res = await fetch(`http://localhost:${port}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: session }),
  });
  expect(res.status).toBe(200);
  return await res.json() as { processed: number; observations_created: number };
}

/** Queue rows, read behind the worker's back — the only way to tell requeued from dead-lettered. */
function queueRows(): Array<{ status: string; retries: number }> {
  const db = new Database(join(workDir, 'queue.db'), { readonly: true });
  try {
    return db.query('SELECT status, retries FROM observation_queue').all() as Array<{ status: string; retries: number }>;
  } finally { db.close(); }
}

/** A summarize() that fails the way a dead provider fails: HTTP status attached, as the transports do. */
function failWith(status: number, message: string) {
  return async (): Promise<SummarizerResult> => {
    const e = new Error(message) as Error & { status?: number };
    e.status = status;
    throw e;
  };
}

const ok = async (): Promise<SummarizerResult> => ({
  type: 'change', title: 'summarized', narrative: 'n', facts: ['f'], concepts: ['c'],
});

const transportFor = (name: string): SummarizerTransport => async () => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ name: `from-${name}`, description: name, slug: `slug-${name}`, type: 'decision' }) }],
  model: name,
});

// ---------------------------------------------------------------------------

test('1. auth-shaped permanent → provider demoted, batch REQUEUED, next provider summarizes it', async () => {
  const excludes: string[][] = [];
  const port = await boot({
    summarize: failWith(401, 'claude-oauth: HTTP 401: unauthorized'),
    summarizerTransport: transportFor('a'),
    summarizerProvider: 'claude-oauth',
    rebuildSummarizer: async (exclude) => {
      excludes.push([...exclude]);
      return { summarize: ok, transport: transportFor('b'), provider: 'agy', skips: [] };
    },
  });

  await enqueue(port, 's1');
  // ONE flush: pass 1 401s and demotes, the loop keeps going, pass 2 runs on the new provider.
  const r = await flush(port, 's1');

  expect(excludes).toEqual([['claude-oauth']]);
  expect(r.observations_created).toBe(1);
  // Requeued, not retried: the row reached 'done' without ever burning a retry, because a failure
  // to REACH a provider is not a verdict about the data.
  expect(queueRows()).toEqual([{ status: 'done', retries: 0 }]);

  const stats = await (await fetch(`http://localhost:${port}/stats`)).json() as
    { summarizer: { provider: string; enabled: boolean; demoted: Array<{ provider: string; reason: string; at_epoch: number }>; last_error: string | null } };
  expect(stats.summarizer.provider).toBe('agy');
  expect(stats.summarizer.enabled).toBe(true);
  expect(stats.summarizer.demoted.length).toBe(1);
  expect(stats.summarizer.demoted[0]!.provider).toBe('claude-oauth');
  expect(stats.summarizer.demoted[0]!.reason).toContain('401');
  expect(stats.summarizer.demoted[0]!.at_epoch).toBeGreaterThan(0);
  // The demotion is history until restart — the new provider's success must not erase it.
  expect(stats.summarizer.last_error).toContain('401');
});

test('2. chain exhausted → dead-letter, exactly as before failover existed', async () => {
  const port = await boot({
    summarize: failWith(401, 'claude-oauth: HTTP 401: unauthorized'),
    summarizerTransport: transportFor('a'),
    summarizerProvider: 'claude-oauth',
    rebuildSummarizer: async () => null,     // nothing left in the chain
  });

  await enqueue(port, 's1');
  const r = await flush(port, 's1');
  expect(r.observations_created).toBe(0);
  expect(queueRows()).toEqual([{ status: 'failed', retries: 0 }]);

  const stats = await (await fetch(`http://localhost:${port}/stats`)).json() as
    { summarizer: { enabled: boolean; demoted: Array<{ provider: string }> } };
  expect(stats.summarizer.enabled).toBe(false);          // summarizer OFF → doctor FAILs
  expect(stats.summarizer.demoted.map(d => d.provider)).toEqual(['claude-oauth']);

  // And it stays off: no cooldown-then-retry, no second chance without a restart.
  await enqueue(port, 's2');
  const res = await fetch(`http://localhost:${port}/observation/flush`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's2' }),
  });
  expect(res.status).toBe(503);
});

test('3. a demoted provider is never re-selected — every exclusion list carries the whole history', async () => {
  const excludes: string[][] = [];
  const port = await boot({
    summarize: failWith(401, 'HTTP 401: unauthorized'),
    summarizerTransport: transportFor('a'),
    summarizerProvider: 'claude-oauth',
    rebuildSummarizer: async (exclude) => {
      excludes.push([...exclude]);
      // Provider #2 is dead the same way; only #3 works.
      if (exclude.length === 1) return { summarize: failWith(401, 'HTTP 401: unauthorized'), transport: transportFor('b'), provider: 'codex', skips: [] };
      return { summarize: ok, transport: transportFor('c'), provider: 'agy', skips: [{ provider: 'anthropic', reason: 'ANTHROPIC_API_KEY is not set' }] };
    },
  });

  await enqueue(port, 's1');
  const r = await flush(port, 's1');

  expect(excludes).toEqual([['claude-oauth'], ['claude-oauth', 'codex']]);
  expect(r.observations_created).toBe(1);

  const stats = await (await fetch(`http://localhost:${port}/stats`)).json() as
    { summarizer: { provider: string; demoted: Array<{ provider: string }>; skipped: Array<{ provider: string }> } };
  expect(stats.summarizer.provider).toBe('agy');
  expect(stats.summarizer.demoted.map(d => d.provider)).toEqual(['claude-oauth', 'codex']);
  // Collateral from the failover walk shows up next to the boot skips, not swallowed.
  expect(stats.summarizer.skipped.map(s => s.provider)).toEqual(['anthropic']);
});

test('4. /remember reaches the NEW transport after a failover (the boot-capture trap)', async () => {
  const seen: string[] = [];
  const spyTransport = (name: string): SummarizerTransport => async (args) => {
    seen.push(name);
    return transportFor(name)(args);
  };
  const port = await boot({
    summarize: failWith(401, 'HTTP 401: unauthorized'),
    summarizerTransport: spyTransport('a'),
    summarizerProvider: 'claude-oauth',
    rebuildSummarizer: async () => ({ summarize: ok, transport: spyTransport('b'), provider: 'agy', skips: [] }),
  });

  await enqueue(port, 's1');
  await flush(port, 's1');           // forces the demotion
  seen.length = 0;

  const res = await fetch(`http://localhost:${port}/remember`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'We standardize on Bun.', type: 'decision', targetDirOverride: workDir }),
  });
  expect(res.status).toBe(200);
  // writeMemory captured `generate` from a per-request read of the transport option. Before the
  // indirection that read handed back the DEAD provider — a green worker writing nothing.
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every(n => n === 'b')).toBe(true);
});

test('6. a failover does not inherit the dead provider\'s overload backoff', async () => {
  // One batch, two groups, two different failures: the API is flaking between 529 and 401. The
  // demotion replaces the very API that was overloading, so its cooldown must not stall the
  // successor — a 10-minute backoff on a healthy provider is a stalled pipeline for no reason.
  const port = await boot({
    summarize: async (events): Promise<SummarizerResult> => {
      const e = new Error(events[0]!.prompt_number === 1 ? 'HTTP 529: overloaded' : 'HTTP 401: unauthorized') as Error & { status?: number };
      e.status = events[0]!.prompt_number === 1 ? 529 : 401;
      throw e;
    },
    summarizerTransport: transportFor('a'),
    summarizerProvider: 'claude-oauth',
    rebuildSummarizer: async () => ({ summarize: ok, transport: transportFor('b'), provider: 'agy', skips: [] }),
  });

  await enqueue(port, 's1', 1);   // 529 → overloaded → requeue + backoff
  await enqueue(port, 's1', 2);   // 401 → auth-shaped permanent → demote
  const r = await flush(port, 's1');

  const stats = await (await fetch(`http://localhost:${port}/stats`)).json() as
    { summarizer: { provider: string; cooling_down: boolean; cooldown_until_epoch: number } };
  expect(stats.summarizer.provider).toBe('agy');
  expect(stats.summarizer.cooling_down).toBe(false);
  expect(stats.summarizer.cooldown_until_epoch).toBe(0);
  // Both groups survive: neither failure was a verdict about the data.
  expect(r.observations_created).toBe(2);
  expect(queueRows().every(row => row.status === 'done')).toBe(true);
});

test('5. a NON-auth permanent (400) does not demote — only a run of DEMOTE_AFTER_PERMANENT_BATCHES does', async () => {
  let rebuilds = 0;
  const port = await boot({
    summarize: failWith(400, 'HTTP 400: {"error":{"message":"authentication scheme"}}'),
    summarizerTransport: transportFor('a'),
    summarizerProvider: 'claude-oauth',
    rebuildSummarizer: async () => {
      rebuilds++;
      return { summarize: ok, transport: transportFor('b'), provider: 'agy', skips: [] };
    },
  });

  // Batches 1 and 2: one bad request must not retire a working provider (the over-demotion trap
  // the auth-shaped classifier exists to prevent). Dead-lettered exactly as today.
  for (const s of ['s1', 's2']) {
    await enqueue(port, s);
    const r = await flush(port, s);
    expect(r.observations_created).toBe(0);
    expect(rebuilds).toBe(0);
  }
  expect(queueRows().every(row => row.status === 'failed')).toBe(true);

  // Batch 3 completes the run — now it IS the provider, and the batch survives the switch.
  await enqueue(port, 's3');
  const r3 = await flush(port, 's3');
  expect(rebuilds).toBe(1);
  expect(r3.observations_created).toBe(1);
  expect(queueRows().filter(row => row.status === 'done').length).toBe(1);
});
