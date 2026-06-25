import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  MANIFEST_FORMAT_VERSION, buildManifest, validateManifest,
  vectorsCompatible, fileSha256, type BackupManifest,
} from '../../src/services/backup/manifest.ts';

function sample(): Omit<BackupManifest, 'format_version' | 'captain_memo_version'> {
  return {
    created_at: '2026-06-25T00:00:00.000Z',
    platform: 'linux',
    embedder: { provider: 'voyage-hosted', model: 'voyage-4-lite', dimension: 1024, endpoint: 'http://x' },
    summarizer: { provider: 'claude-oauth', model: 'claude-haiku-4-5' },
    includes_secrets: true,
    includes_vectors: true,
    files: [{ path: 'data/meta.sqlite3', size: 10, sha256: 'abc' }],
    counts: { documents: 1, chunks: 2, observations: 3, vectors: 2 },
  };
}

test('buildManifest stamps format version and app version', () => {
  const m = buildManifest(sample());
  expect(m.format_version).toBe(MANIFEST_FORMAT_VERSION);
  expect(typeof m.captain_memo_version).toBe('string');
  expect(m.captain_memo_version.length).toBeGreaterThan(0);
  expect(m.embedder.model).toBe('voyage-4-lite');
});

test('validateManifest round-trips a built manifest', () => {
  const m = buildManifest(sample());
  const parsed = validateManifest(JSON.parse(JSON.stringify(m)));
  expect(parsed).toEqual(m);
});

test('validateManifest rejects a non-object', () => {
  expect(() => validateManifest(null)).toThrow();
  expect(() => validateManifest('nope')).toThrow();
});

test('validateManifest rejects an unsupported format version', () => {
  const m = buildManifest(sample()) as BackupManifest;
  expect(() => validateManifest({ ...m, format_version: 999 })).toThrow(/format version/i);
});

test('validateManifest rejects a missing embedder model/dimension', () => {
  const m = buildManifest(sample()) as BackupManifest;
  expect(() => validateManifest({ ...m, embedder: { model: 'x' } })).toThrow();
  expect(() => validateManifest({ ...m, embedder: { dimension: 1 } })).toThrow();
  expect(() => validateManifest({ ...m, embedder: 42 })).toThrow();
});

test('validateManifest rejects missing or non-numeric counts fields', () => {
  const m = buildManifest(sample()) as BackupManifest;
  expect(() => validateManifest({ ...m, counts: {} })).toThrow(/counts.*must be a number/);
});

test('vectorsCompatible requires same model and dimension', () => {
  const base = { model: 'm', dimension: 1024 };
  expect(vectorsCompatible(base, { model: 'm', dimension: 1024 })).toBe(true);
  expect(vectorsCompatible(base, { model: 'm', dimension: 2048 })).toBe(false);
  expect(vectorsCompatible(base, { model: 'other', dimension: 1024 })).toBe(false);
});

test('fileSha256 hashes file bytes (matches a known value)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-manifest-'));
  const p = join(dir, 'f.bin');
  writeFileSync(p, 'hello');
  // sha256("hello")
  expect(await fileSha256(p)).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});
