import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createArchive } from '../../src/services/backup/snapshot.ts';
import { readBackupInfo, formatBackupInfo } from '../../src/services/backup/info.ts';

async function archiveWith(manifest: unknown): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cm-info-'));
  const staging = join(dir, 's'); mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest));
  const out = join(dir, 'a.tar.gz');
  await createArchive(staging, out);
  return out;
}

test('formatBackupInfo strips control chars from untrusted manifest fields (no terminal injection)', async () => {
  const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7), CR = String.fromCharCode(13), LF = String.fromCharCode(10);
  const out = await archiveWith({
    format_version: 1,
    captain_memo_version: '9.9.9' + LF + '  secrets:     not included',
    created_at: '2026-01-01' + ESC + '[31mX',
    platform: 'linux' + CR,
    embedder: { model: 'evil' + BEL + 'model', dimension: 1024, endpoint: 'http://x' + ESC + '[0m' },
    summarizer: {}, includes_secrets: true, includes_vectors: false, files: [],
    counts: { documents: 0, chunks: 0, observations: 0, vectors: 0 },
  });
  const text = formatBackupInfo(await readBackupInfo(out));
  expect(text.includes(ESC)).toBe(false);
  expect(text.includes(BEL)).toBe(false);
  expect(text.includes(CR)).toBe(false);
  expect(text.split(LF).length).toBe(7);          // forged LF added no extra line
  expect(text).toMatch(/secrets:\s+INCLUDED/);    // real secrets status preserved
});

test('readBackupInfo returns the manifest and formatBackupInfo summarizes it', async () => {
  const out = await archiveWith({
    format_version: 1, captain_memo_version: '0.13.1', created_at: '2026-06-25T10:00:00.000Z',
    platform: 'linux', embedder: { model: 'voyage-4-lite', dimension: 1024 }, summarizer: {},
    includes_secrets: true, includes_vectors: true, files: [],
    counts: { documents: 4, chunks: 9, observations: 7, vectors: 9 },
  });
  const m = await readBackupInfo(out);
  expect(m.counts.chunks).toBe(9);
  const text = formatBackupInfo(m);
  expect(text).toContain('voyage-4-lite');
  expect(text).toContain('1024');
  expect(text).toMatch(/secrets/i);
  expect(text).toContain('0.13.1');
});
