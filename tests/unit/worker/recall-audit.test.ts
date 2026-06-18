import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeRecallAuditLine } from '../../../src/worker/recall-audit.ts';

let dir: string | null = null;
afterEach(() => {
  delete process.env.CAPTAIN_MEMO_RECALL_AUDIT;
  delete process.env.CAPTAIN_MEMO_DATA_DIR;
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
});

test('audit entry persists rank_profile', async () => {
  dir = mkdtempSync(join(tmpdir(), 'cm-audit-'));
  process.env.CAPTAIN_MEMO_DATA_DIR = dir;
  process.env.CAPTAIN_MEMO_RECALL_AUDIT = '1';
  await writeRecallAuditLine({
    ts: 1, session_id: 's', project_id: 'p', query: 'q',
    rank_profile: 'v2', hits: [],
  });
  const line = readFileSync(join(dir, 'recall-audit.jsonl'), 'utf8').trim();
  expect(JSON.parse(line).rank_profile).toBe('v2');
});
