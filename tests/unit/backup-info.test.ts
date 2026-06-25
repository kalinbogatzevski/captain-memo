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
