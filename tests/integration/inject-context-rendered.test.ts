import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

// 2026-09-28: over budget the envelope was cut from its end, so a hit that won a top_k slot could be missing from
// the envelope while hit_count, k=, the recall audit (read by dreaming's co-retrieval pairs) and the from_auto bump
// all still counted it. Now formatEnvelope drops a hit whole when its header does not fit and says what rendered;
// the worker counts, audits and bumps only that.

const TITLES = ['apple harvest rota', 'apple cider pressing', 'apple orchard frost', 'apple crate labels'];
let workDir: string;
let w: WorkerHandle;
let prevDataDir: string | undefined;

const post = (path: string, body: unknown) => fetch(`http://localhost:${w.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function boot(extra: Partial<Parameters<typeof startWorker>[0]> = {}): Promise<void> {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-inject-rendered-'));
  prevDataDir = process.env.CAPTAIN_MEMO_DATA_DIR;
  process.env.CAPTAIN_MEMO_DATA_DIR = workDir;   // the recall audit resolves its path per write
  w = await startWorker({
    port: 0, projectId: 't-inject-rendered', metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused', embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'), embeddingDimension: 8, skipEmbed: true,
    observationQueueDbPath: join(workDir, 'queue.db'), observationsDbPath: join(workDir, 'obs.db'),
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    summarize: async (events) => ({ type: 'discovery', title: events[0]!.tool_input_summary, narrative: `${events[0]!.tool_input_summary}: ${'the apple crop was sorted, weighed and logged by number. '.repeat(8)}`, facts: [], concepts: [] }),
    observationTickMs: 0,
    ...extra,
  });
}

afterEach(async () => {
  await w.stop();
  if (prevDataDir === undefined) delete process.env.CAPTAIN_MEMO_DATA_DIR; else process.env.CAPTAIN_MEMO_DATA_DIR = prevDataDir;
  rmWorkDir(workDir);
});

test('at a budget too small for every header: hit_count, k=, the recall audit and the from_auto bump count only what rendered', async () => {
  await boot();
  for (const [i, t] of TITLES.entries()) {
    await post('/observation/enqueue', { session_id: `seed${i}`, project_id: 'p', prompt_number: 1, tool_name: 'Edit', tool_input_summary: t, tool_result_summary: 'ok', files_read: [], files_modified: [], ts_epoch: 1_700_000_000 + i });
    await post('/observation/flush', { session_id: `seed${i}` });
  }
  // All four must be searchable, or a "not rendered" below could just be "not found".
  let found = 0;
  for (let i = 0; i < 50 && found < 4; i++) {
    const r = await (await post('/search/observations', { query: 'apple', top_k: 10 })).json() as { results: Array<{ title: string }> };
    found = r.results.filter((h) => TITLES.some((t) => h.title.includes(t))).length;
    if (found < 4) await new Promise((res) => setTimeout(res, 100));
  }
  if (found < 4) throw new Error(`only ${found}/4 observations searchable`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await (await post('/inject/context', { prompt: 'what is the apple and what number does it have', top_k: 5, budget_tokens: 300 })).json() as any;
  const shown = TITLES.filter((t) => r.envelope.includes(`"${t}"`));
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.length).toBeLessThan(4);   // the budget dropped some whole
  expect(r.hit_count).toBe(shown.length);
  expect(r.envelope).toContain(`k="${shown.length}"`);
  expect(r.envelope).toContain(`## Session memory (${shown.length} results)`);
  const auditPath = join(workDir, 'recall-audit.jsonl');
  // The audit line is appended asynchronously: wait for a whole line, not just the file (it can exist, still empty).
  const lastLine = () => (existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '').split('\n').filter(Boolean).at(-1);
  for (let i = 0; i < 100 && !lastLine()?.endsWith('}'); i++) await new Promise((res) => setTimeout(res, 20));
  const audit = JSON.parse(lastLine()!) as { hits: Array<{ doc_id: string }> };
  expect(audit.hits).toHaveLength(shown.length);
  const stats = await (await fetch(`http://localhost:${w.port}/stats`)).json() as { recall: { totals: { auto: number } } };
  expect(stats.recall.totals.auto).toBe(shown.length);   // one bump per observation the model saw, none for the dropped
});

test('a URL credential straddling the snippet cap is redacted whole, not cut before its @ and injected', async () => {
  const memDir = join(mkdtempSync(join(tmpdir(), 'captain-memo-inject-key-')), 'memory');
  try {
    mkdirSync(memDir, { recursive: true });
    const pw = 'FAKEpw0'.repeat(100);
    // top_k 5 at 4 000 tokens cuts each snippet at max(600, 4000 / 5 * 3.6) = 2 880 chars (index.ts snippetChars):
    // between this URL's ':' and its '@', where the cut half no longer looks like a credential at all.
    // The token up front is also the head of the recall audit's 200-char snippet, which is cut from the raw chunk.
    const body = `Runner token glpat-AbCdEfGhIjKlMnOpQrSt12 lives in worker.env.\n${'The runner deploy procedure: pull, build, restart the runner service. '.repeat(35)}\n`
      + `The runner pushes to https://svc:${pw}@git.example/runner.git after every build.\n`;
    expect(body.indexOf('svc:')).toBeLessThan(2880);
    expect(body.indexOf('@git.example')).toBeGreaterThan(2880);
    writeFileSync(join(memDir, 'reference_runner.md'), `---\ntype: reference\ndescription: runner deploy\n---\n${body}`);
    // A 32k-token embedder keeps the file one chunk (voyage-4-nano's 512 would split it before the snippet cap could).
    await boot({ watchPaths: [join(memDir, '*.md')], watchChannel: 'memory', embedderModel: 'voyage-4-large' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let r: any;
    for (let i = 0; i < 50; i++) {
      r = await (await post('/inject/context', { prompt: 'how do I restart the runner deploy', top_k: 5, budget_tokens: 4000 })).json();
      if (r.hit_count > 0) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(r.hit_count).toBe(1);
    expect(r.envelope).toContain('https://svc:[REDACTED]@git.example/runner.git');
    expect(r.envelope).not.toContain('FAKEpw0');
    expect(r.envelope).toContain('(2 credential-shaped values redacted — get_full(');
    const auditPath = join(workDir, 'recall-audit.jsonl');
    // The audit line is appended asynchronously: wait for a whole line, not just the file (it can exist, still empty).
    const lastLine = () => (existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '').split('\n').filter(Boolean).at(-1);
    for (let i = 0; i < 100 && !lastLine()?.endsWith('}'); i++) await new Promise((res) => setTimeout(res, 20));
    const audit = JSON.parse(lastLine()!) as { hits: Array<{ snippet: string }> };
    expect(audit.hits[0]!.snippet).toStartWith('Runner token [REDACTED:gitlab-token] lives in worker.env.');
  } finally {
    rmWorkDir(join(memDir, '..'));
  }
});
