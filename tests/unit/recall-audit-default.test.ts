import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeRecallAuditLine } from '../../src/worker/recall-audit.ts';

// The recall audit was default-OFF on privacy grounds — but `dream` reads it, so default-off meant
// dream was dead out of the box and the stats page said "disabled" with no hint why.
//
// The privacy argument does not survive contact with the filesystem: the log never leaves the machine
// (never indexed into the corpus, never relayed to a peer or the hub — every reader is local), the raw
// prompts are already in the Claude transcript on the same disk, and the memory snippets are already in
// observations.db on the same disk. It is a copy of what the machine already holds.
//
// What IS real is unbounded growth: one live host reached 24.7 MB with nothing to stop it. Default-on
// without a bound is how you fill a customer's disk.
let dir: string;
const ENV = { ...process.env };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cm-audit-')); process.env.CAPTAIN_MEMO_DATA_DIR = dir; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); process.env = { ...ENV }; });

const entry = () => ({
  ts: 1_700_000_000_000, session_id: 's', project_id: 'p',
  query: 'q', rank_profile: 'default', injected_tokens: 1234,
  hits: [{ doc_id: 'doc-1', channel: 'observation', score: 0.9, snippet: 'snip' }],
});
const logPath = () => join(dir, 'recall-audit.jsonl');

test('BY DEFAULT it writes — dream works out of the box', async () => {
  delete process.env.CAPTAIN_MEMO_RECALL_AUDIT;
  await writeRecallAuditLine(entry() as never);
  const line = JSON.parse(readFileSync(logPath(), 'utf8').trim());
  expect(line.ts).toBe(1_700_000_000_000);       // what dream reads
  expect(line.injected_tokens).toBe(1234);
  expect(line.hits[0].doc_id).toBe('doc-1');
  expect(line.query).toBe('q');                   // full fidelity retained — it is a local audit
});

test('=0 opts OUT entirely — no file at all', async () => {
  process.env.CAPTAIN_MEMO_RECALL_AUDIT = '0';
  await writeRecallAuditLine(entry() as never);
  expect(existsSync(logPath())).toBe(false);
});

test('=1 still means on (nobody who set it explicitly gets surprised)', async () => {
  process.env.CAPTAIN_MEMO_RECALL_AUDIT = '1';
  await writeRecallAuditLine(entry() as never);
  expect(existsSync(logPath())).toBe(true);
});

test('the log is BOUNDED — it rotates instead of growing forever', async () => {
  delete process.env.CAPTAIN_MEMO_RECALL_AUDIT;
  process.env.CAPTAIN_MEMO_RECALL_AUDIT_MAX_BYTES = '2000';
  writeFileSync(logPath(), 'x'.repeat(3000));                       // already over the cap
  await writeRecallAuditLine(entry() as never);
  expect(existsSync(logPath() + '.1')).toBe(true);                  // one generation kept
  expect(readFileSync(logPath(), 'utf8').length).toBeLessThan(2000); // fresh file
});

test('rotation keeps exactly ONE generation — .1 is replaced, never .2', async () => {
  delete process.env.CAPTAIN_MEMO_RECALL_AUDIT;
  process.env.CAPTAIN_MEMO_RECALL_AUDIT_MAX_BYTES = '500';
  for (let i = 0; i < 3; i++) {
    writeFileSync(logPath(), 'x'.repeat(900));
    await writeRecallAuditLine(entry() as never);
  }
  expect(existsSync(logPath() + '.1')).toBe(true);
  expect(existsSync(logPath() + '.2')).toBe(false);
});
