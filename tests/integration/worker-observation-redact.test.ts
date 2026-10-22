// POST /observation/enqueue is the ingress of every hook: Claude Code's PostToolUse and PreCompact and the native Codex, Gemini and
// Kimi hooks (src/hooks/post-tool-use.ts, pre-compact.ts, dispatcher.ts). Credential-shaped text in the two free-text fields they
// fill must be gone before the queue row is written and before the summarizer provider is called. Placeholders only.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import type { RawObservationEvent } from '../../src/shared/types.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

const GITLAB = 'glpat-' + 'x'.repeat(20);
const PASSWORD = 'Placeholder-Pw-0000';

let worker: WorkerHandle;
let workDir: string;
let summarized: RawObservationEvent[];

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-obs-redact-'));
  summarized = [];
  worker = await startWorker({
    port: 0,
    projectId: 'obs-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    observationQueueDbPath: join(workDir, 'queue.db'),
    observationsDbPath: join(workDir, 'obs.db'),
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    summarize: async (events) => {
      summarized.push(...events);
      return { type: 'change', title: 'stub', narrative: 'stub narrative', facts: [], concepts: ['stub'] };
    },
    observationTickMs: 0, // no auto-tick: the test flushes
  });
});

afterEach(async () => {
  await worker.stop();
  rmWorkDir(workDir);
});

const base = (over: Record<string, unknown> = {}) => ({
  session_id: 's-redact', project_id: 'p1', prompt_number: 1, tool_name: 'Bash',
  tool_input_summary: '{"command":"ls"}', tool_result_summary: 'ok', files_read: [], files_modified: [], ts_epoch: 1_700_000_000,
  ...over,
});

async function enqueue(body: object): Promise<Response> {
  return fetch(`http://localhost:${worker.port}/observation/enqueue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** What the route stored: the queue rows' payloads, read straight from queue.db. */
function queued(): Record<string, unknown>[] {
  const db = new Database(join(workDir, 'queue.db'), { readonly: true });
  try { return (db.query('SELECT payload FROM observation_queue ORDER BY id').all() as Array<{ payload: string }>).map((r) => JSON.parse(r.payload)); }
  finally { db.close(); }
}

async function flush(session = 's-redact'): Promise<void> {
  const res = await fetch(`http://localhost:${worker.port}/observation/flush`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: session }) });
  expect(res.status).toBe(200);
}

// The three shapes the senders actually post, read from the senders: PostToolUse (Claude Code: no source; tool_input is the
// JSON of the tool's input), a native Codex hook (source hook:codex), PreCompact (an empty tool_input_summary, the payload in the result).
const SENDERS: Record<string, (text: string) => object> = {
  'Claude Code PostToolUse': (t) => base({ tool_input_summary: `{"command":"${t}"}`, tool_result_summary: `${t} done`, origin_agent: 'claude-code' }),
  'native Codex hook': (t) => base({ tool_input_summary: `{"command":"${t}"}`, tool_result_summary: `${t} done`, origin_agent: 'codex', source: 'hook:codex' }),
  'PreCompact': (t) => base({ tool_name: 'pre-compact', tool_input_summary: '', tool_result_summary: `{"trigger":"auto","custom_instructions":"${t}"}`, source: 'pre-compact' }),
};

for (const [sender, make] of Object.entries(SENDERS)) {
  test(`${sender}: a token-shaped value is gone from the queue row and from what the summarizer is given, the words around it stay`, async () => {
    const res = await enqueue(make(`before ${GITLAB} between password=${PASSWORD} after`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1, queued: true });   // the response shape is unchanged
    await flush();

    const row = queued()[0]! as unknown as RawObservationEvent;
    expect(summarized).toHaveLength(1);
    for (const text of [row.tool_input_summary + row.tool_result_summary, summarized[0]!.tool_input_summary + summarized[0]!.tool_result_summary]) {
      expect(text).not.toContain(GITLAB);
      expect(text).not.toContain(PASSWORD);
      expect(text).toContain('[REDACTED');
      expect(text).toContain('before ');
      expect(text).toContain(' between password=');
      expect(text).toContain(' after');
    }
  });
}

test('each free-text field is redacted on its own', async () => {
  await enqueue(base({ prompt_number: 1, tool_input_summary: `use ${GITLAB} now` }));
  await enqueue(base({ prompt_number: 2, tool_result_summary: `assistant: password=${PASSWORD} is set` }));
  const [first, second] = queued() as unknown as RawObservationEvent[];
  expect(first!.tool_input_summary).toBe('use [REDACTED:gitlab-token] now');
  expect(first!.tool_result_summary).toBe('ok');
  expect(second!.tool_input_summary).toBe('{"command":"ls"}');
  expect(second!.tool_result_summary).toBe('assistant: password=[REDACTED] is set');
});

test('a clean payload is stored exactly as it was sent', async () => {
  const clean = base({ tool_input_summary: '{"command":"git status && cat README.md"}', tool_result_summary: 'On branch main\nnothing to commit\n', files_read: ['/tmp/proj/README.md'], origin_agent: 'claude-code', source: 'hook:claude' });
  expect((await enqueue(clean)).status).toBe(200);
  expect(queued()).toEqual([{ ...clean, branch: null }]);
});

test('paths and ids are not rewritten: only the two free-text fields', async () => {
  const path = `/home/u/${GITLAB}.txt`;   // a path is not a credential shape; rewriting one would break the file lookups
  await enqueue(base({ tool_name: 'Edit', files_modified: [path], files_read: [path], tool_input_summary: `edit ${GITLAB}` }));
  const row = queued()[0]! as unknown as RawObservationEvent;
  expect(row.files_modified).toEqual([path]);
  expect(row.files_read).toEqual([path]);
  expect(row.tool_name).toBe('Edit');
  expect(row.tool_input_summary).toBe('edit [REDACTED:gitlab-token]');
});
