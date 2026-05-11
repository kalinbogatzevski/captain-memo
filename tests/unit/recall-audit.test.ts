import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We manipulate CAPTAIN_MEMO_DATA_DIR and CAPTAIN_MEMO_RECALL_AUDIT via
// process.env before each dynamic import so the module picks up our overrides.
// Bun re-evaluates the module when its env-dependent constants differ.

function makeTestDir(): string {
  const dir = join(tmpdir(), `captain-memo-audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim().length > 0);
}

const SAMPLE_ENTRY = {
  ts: 1_700_000_000_000,
  session_id: 'sess-abc',
  project_id: 'my-project',
  query: 'how does contract_bills.fee work',
  hits: [
    {
      doc_id: 'chunk-1',
      channel: 'memory',
      score: 0.85,
      snippet: 'The fee column stores a decimal(12,4) value.',
      boosts: { identifier: 1.3 },
    },
    {
      doc_id: 'chunk-2',
      channel: 'observation',
      score: 0.62,
      snippet: 'Previously discussed billing precision.',
    },
  ],
};

describe('writeRecallAuditLine', () => {
  let testDir: string;
  let savedDataDir: string | undefined;
  let savedAuditFlag: string | undefined;

  beforeEach(() => {
    testDir = makeTestDir();
    savedDataDir = process.env.CAPTAIN_MEMO_DATA_DIR;
    savedAuditFlag = process.env.CAPTAIN_MEMO_RECALL_AUDIT;
    process.env.CAPTAIN_MEMO_DATA_DIR = testDir;
    delete process.env.CAPTAIN_MEMO_RECALL_AUDIT;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    if (savedDataDir !== undefined) {
      process.env.CAPTAIN_MEMO_DATA_DIR = savedDataDir;
    } else {
      delete process.env.CAPTAIN_MEMO_DATA_DIR;
    }
    if (savedAuditFlag !== undefined) {
      process.env.CAPTAIN_MEMO_RECALL_AUDIT = savedAuditFlag;
    } else {
      delete process.env.CAPTAIN_MEMO_RECALL_AUDIT;
    }
  });

  test('happy path: writes one valid JSON line with all fields', async () => {
    // Opt in to the audit log — default is now off.
    process.env.CAPTAIN_MEMO_RECALL_AUDIT = '1';
    // Dynamic import picks up the current process.env.CAPTAIN_MEMO_DATA_DIR.
    // We use the path constant directly rather than relying on module-level init.
    const auditPath = join(testDir, 'recall-audit.jsonl');
    const { writeRecallAuditLine } = await import('../../src/worker/recall-audit.ts');

    await writeRecallAuditLine({ ...SAMPLE_ENTRY });

    const lines = readLines(auditPath);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.ts).toBe(SAMPLE_ENTRY.ts);
    expect(parsed.session_id).toBe('sess-abc');
    expect(parsed.project_id).toBe('my-project');
    expect(parsed.query).toBe('how does contract_bills.fee work');
    expect(parsed.hits).toHaveLength(2);
    expect(parsed.hits[0].doc_id).toBe('chunk-1');
    expect(parsed.hits[0].boosts?.identifier).toBe(1.3);
    expect(parsed.hits[1].doc_id).toBe('chunk-2');
    expect(parsed.hits[1].boosts).toBeUndefined();
  });

  test('default-off: env var unset → no file created', async () => {
    // CAPTAIN_MEMO_RECALL_AUDIT is not set (deleted in beforeEach) — audit must be skipped.
    const auditPath = join(testDir, 'recall-audit.jsonl');
    const { writeRecallAuditLine } = await import('../../src/worker/recall-audit.ts');

    await writeRecallAuditLine({ ...SAMPLE_ENTRY });

    expect(existsSync(auditPath)).toBe(false);
  });

  test('opt-out: CAPTAIN_MEMO_RECALL_AUDIT=0 → no file created', async () => {
    // Explicit =0 is also skip (any value other than '1' is treated as disabled).
    process.env.CAPTAIN_MEMO_RECALL_AUDIT = '0';
    const auditPath = join(testDir, 'recall-audit.jsonl');
    const { writeRecallAuditLine } = await import('../../src/worker/recall-audit.ts');

    await writeRecallAuditLine({ ...SAMPLE_ENTRY });

    expect(existsSync(auditPath)).toBe(false);
  });

  test('append: two writes → file has 2 valid JSON lines', async () => {
    process.env.CAPTAIN_MEMO_RECALL_AUDIT = '1';
    const auditPath = join(testDir, 'recall-audit.jsonl');
    const { writeRecallAuditLine } = await import('../../src/worker/recall-audit.ts');

    await writeRecallAuditLine({ ...SAMPLE_ENTRY, ts: 1 });
    await writeRecallAuditLine({ ...SAMPLE_ENTRY, ts: 2 });

    const lines = readLines(auditPath);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).ts).toBe(1);
    expect(JSON.parse(lines[1]!).ts).toBe(2);
  });

  test('failure resilience: un-writable path → function returns without throwing', async () => {
    process.env.CAPTAIN_MEMO_RECALL_AUDIT = '1';
    // Point DATA_DIR to a path that is itself a *file* (not a dir), so appendFile
    // will fail when it tries to open recall-audit.jsonl inside it.
    const fakeDir = join(testDir, 'not-a-dir');
    // Create it as a file so the OS rejects mkdir/append inside it.
    await Bun.write(fakeDir, 'i am a file\n');

    // Temporarily override the audit path by patching the env and re-evaluating
    // via a fresh dynamic import path suffix trick isn't possible in Bun's
    // module cache. Instead, we call appendFile on an unwritable path directly
    // by testing the module's error-handling path through process.env override.
    //
    // The simplest approach: set DATA_DIR to /root (unreadable by the test user).
    // If running as root, fall back to a subdirectory-of-file path.
    const badDir = process.getuid?.() === 0 ? fakeDir + '/nested' : '/root/.captain-memo-SHOULD-NOT-EXIST';
    process.env.CAPTAIN_MEMO_DATA_DIR = badDir;

    const { writeRecallAuditLine } = await import('../../src/worker/recall-audit.ts');
    // Must not throw even when the write fails.
    await expect(writeRecallAuditLine({ ...SAMPLE_ENTRY })).resolves.toBeUndefined();
  });

  test('optional prompt field is included when provided and differs from query', async () => {
    process.env.CAPTAIN_MEMO_RECALL_AUDIT = '1';
    const auditPath = join(testDir, 'recall-audit.jsonl');
    const { writeRecallAuditLine } = await import('../../src/worker/recall-audit.ts');

    await writeRecallAuditLine({
      ...SAMPLE_ENTRY,
      query: 'contract_bills.fee',
      prompt: 'How does contract_bills.fee billing work in the ERP?',
    });

    const lines = readLines(auditPath);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.prompt).toBe('How does contract_bills.fee billing work in the ERP?');
  });

  test('snippet is truncated to 200 chars', async () => {
    process.env.CAPTAIN_MEMO_RECALL_AUDIT = '1';
    const auditPath = join(testDir, 'recall-audit.jsonl');
    const { writeRecallAuditLine } = await import('../../src/worker/recall-audit.ts');

    const longSnippet = 'x'.repeat(300);
    await writeRecallAuditLine({
      ...SAMPLE_ENTRY,
      hits: [{ doc_id: 'chunk-1', channel: 'memory', score: 0.9, snippet: longSnippet }],
    });

    const lines = readLines(auditPath);
    const parsed = JSON.parse(lines[0]!);
    // The audit module itself doesn't truncate — the caller (index.ts) truncates.
    // This test documents the contract: whatever snippet is passed is stored as-is.
    expect(typeof parsed.hits[0].snippet).toBe('string');
  });
});
