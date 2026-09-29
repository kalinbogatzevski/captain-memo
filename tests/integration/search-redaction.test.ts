import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

// 2026-09-29: search_memory / search_skill / search_observations / search_all handed the model a 600-char cut of the raw
// chunk and the raw title and metadata labels, where /inject/context redacts. Every value here is made up.

let workDir = '';
let w: WorkerHandle | null = null;
let prevDataDir: string | undefined;

const post = (path: string, body: unknown) => fetch(`http://localhost:${w!.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** One memory file, one chunk per H2, and a 32k-token embedder model (voyage-4-nano's 512 would split it first). */
async function boot(body: string, frontmatter = 'type: reference\ndescription: runner deploy'): Promise<void> {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-search-redact-'));
  prevDataDir = process.env.CAPTAIN_MEMO_DATA_DIR;
  process.env.CAPTAIN_MEMO_DATA_DIR = workDir;
  const memDir = join(workDir, 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, 'reference_runner.md'), `---\n${frontmatter}\n---\n${body}`);
  w = await startWorker({
    port: 0, projectId: 't-search-redact', metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused', embedderModel: 'voyage-4-large',
    vectorDbPath: join(workDir, 'vec.db'), embeddingDimension: 8, skipEmbed: true,
    observationQueueDbPath: join(workDir, 'queue.db'), observationsDbPath: join(workDir, 'obs.db'),
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    watchPaths: [join(memDir, '*.md')], watchChannel: 'memory',
  });
}

type R = { results: Array<{ title: string; snippet: string }> };
async function searchBoth(): Promise<[R, R]> {
  let mem: R = { results: [] };
  for (let i = 0; i < 50 && mem.results.length === 0; i++) {
    mem = await (await post('/search/memory', { query: 'runner deploy', top_k: 5 })).json() as R;
    if (mem.results.length === 0) await new Promise((res) => setTimeout(res, 100));
  }
  const all = await (await post('/search/all', { query: 'runner deploy', top_k: 5 })).json() as R;
  return [mem, all];
}

afterEach(async () => {
  if (w) { await w.stop(); w = null; }
  if (prevDataDir === undefined) delete process.env.CAPTAIN_MEMO_DATA_DIR; else process.env.CAPTAIN_MEMO_DATA_DIR = prevDataDir;
  rmWorkDir(workDir); workDir = '';
});

const PROSE = 'The runner deploy procedure: pull, build, restart the runner service. ';
const SEARCH_CUT = 600;
const TOKEN = 'glpat-FAKEfakeFAKEfake0000';

test('search_* / search_all snippets are redacted before their 600-char cut', async () => {
  // Cut 4 chars after 'glpat-': 4 < the 16 the gitlab rule needs, so a cut-then-redact leaks 'glpat-FAKE'.
  const body = `${PROSE.repeat(10).slice(0, SEARCH_CUT - 11)} ${TOKEN} and the runner restarts.\n`;
  expect(body.slice(0, SEARCH_CUT).endsWith('glpat-FAKE')).toBe(true);
  await boot(body);
  for (const { results } of await searchBoth()) {
    expect(results).toHaveLength(1);
    expect(results[0]!.snippet.length).toBeLessThanOrEqual(SEARCH_CUT);
    expect(results[0]!.snippet).toContain('[REDACTED');
    expect(results[0]!.snippet).not.toContain('glpat-');
  }
});

test('search_* / search_all titles and metadata labels are redacted', async () => {
  await boot(`## Runner creds token=Qz7FAKEfake9Lm2x\n${PROSE}\n${TOKEN}\n`,
    `type: reference\nname: runner ${TOKEN}\ndescription: runner deploy with ${TOKEN}`);
  const res = await searchBoth();
  for (const { results } of res) {
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('Runner creds token=[REDACTED]');
  }
  const json = JSON.stringify(res);
  expect(json).not.toContain('glpat-');
  expect(json).not.toContain('Qz7FAKEfake9Lm2x');
});

// /inject/context passes a credential-shaped chunk whole (a cut before redaction leaks half a secret), so formatEnvelope
// must cut it to the same snippet_chars after redaction: the tokenizer is superlinear on a long run of one letter.
test('/inject/context cuts a whole credential-shaped chunk to its snippet cap after redaction', async () => {
  // top_k 5 at 4 000 tokens: snippetChars 2 880. The chunk is ~5.4K chars, ~1.1K tokens — under budget, so only the
  // char cut drops the sentinel.
  const body = `Runner token ${TOKEN}\n${PROSE.repeat(45)}SENTINELWORD ${PROSE.repeat(30)}\n`;
  expect(body.indexOf('SENTINELWORD')).toBeGreaterThan(2880);
  await boot(body);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let r: any;
  for (let i = 0; i < 50; i++) {
    r = await (await post('/inject/context', { prompt: 'how do I restart the runner deploy', top_k: 5, budget_tokens: 4000 })).json();
    if (r.hit_count > 0) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  expect(r.hit_count).toBe(1);
  expect(r.envelope).toContain('Runner token [REDACTED:gitlab-token]');
  expect(r.envelope).not.toContain('SENTINELWORD');
});
