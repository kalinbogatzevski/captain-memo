import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setWorkerEnvVar } from './worker-env.ts';

function tmpEnvFile(initial?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cm-env-'));
  const path = join(dir, 'worker.env');
  if (initial !== undefined) writeFileSync(path, initial);
  return path;
}

test('setWorkerEnvVar rewrites an existing key in place, preserving other lines', () => {
  const path = tmpEnvFile('CAPTAIN_MEMO_EMBEDDER_MODEL=voyageai/voyage-4-lite\nCAPTAIN_MEMO_EMBEDDING_DIM=2048\nCAPTAIN_MEMO_WORKER_PORT=39888\n');
  setWorkerEnvVar('CAPTAIN_MEMO_EMBEDDING_DIM', '1024', path);
  const out = readFileSync(path, 'utf8');
  expect(out).toContain('CAPTAIN_MEMO_EMBEDDING_DIM=1024');
  expect(out).not.toContain('=2048');
  expect(out).toContain('CAPTAIN_MEMO_EMBEDDER_MODEL=voyageai/voyage-4-lite');
  expect(out).toContain('CAPTAIN_MEMO_WORKER_PORT=39888');
});

test('setWorkerEnvVar appends a missing key without accreting blank lines', () => {
  const path = tmpEnvFile('CAPTAIN_MEMO_WORKER_PORT=39888\n');
  setWorkerEnvVar('CAPTAIN_MEMO_EMBEDDING_DIM', '1024', path);
  const out = readFileSync(path, 'utf8');
  expect(out).toBe('CAPTAIN_MEMO_WORKER_PORT=39888\nCAPTAIN_MEMO_EMBEDDING_DIM=1024\n');
});

test('setWorkerEnvVar creates the file when absent', () => {
  const path = tmpEnvFile(); // not written yet
  setWorkerEnvVar('CAPTAIN_MEMO_EMBEDDING_DIM', '1024', path);
  expect(readFileSync(path, 'utf8')).toBe('CAPTAIN_MEMO_EMBEDDING_DIM=1024\n');
});
