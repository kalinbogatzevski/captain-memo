import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadExistingConfig, gatherConfig } from '../../src/cli/commands/install.ts';

let dir: string;
let envPath: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cm-preserve-')); envPath = join(dir, 'worker.env'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const write = (lines: string[]) => writeFileSync(envPath, lines.join('\n') + '\n');
const reinstall = () => gatherConfig(loadExistingConfig(envPath), { nonInteractive: true } as any);

const HOSTED = [
  'CAPTAIN_MEMO_DATA_DIR=/home/u/.captain-memo',
  'CAPTAIN_MEMO_EMBEDDER_ENDPOINT=https://api.voyageai.com/v1/embeddings',
  'CAPTAIN_MEMO_EMBEDDER_MODEL=voyage-3-large',
  'CAPTAIN_MEMO_EMBEDDING_DIM=2048',
  'CAPTAIN_MEMO_EMBEDDER_API_KEY=pa-secret-key-xyz',
  'CAPTAIN_MEMO_SUMMARIZER_PROVIDER=anthropic',
  'CAPTAIN_MEMO_SUMMARIZER_MODEL=claude-opus-4-8',
  'CAPTAIN_MEMO_HOOK_TIMEOUT_MS=5000',
  'CAPTAIN_MEMO_WATCH_MEMORY=/custom/path/*.md',
];

test('loadExistingConfig parses a hosted worker.env back into a WizardConfig', () => {
  write(HOSTED);
  const c = loadExistingConfig(envPath);
  expect(c.embedder).toBe('voyage-hosted');
  expect(c.embedderApiKey).toBe('pa-secret-key-xyz');
  expect(c.embedderModel).toBe('voyage-3-large');
  expect(c.embeddingDimension).toBe(2048);
  expect(c.summarizer).toBe('anthropic');
  expect(c.summarizerModel).toBe('claude-opus-4-8');
  expect(c.hookTimeoutMs).toBe(5000);
  expect(c.watchMemory).toBe('/custom/path/*.md');
});

// The headline regression: `install --yes` must keep the key AND every non-default
// field — model, NON-1024 dimension, summarizer provider+model, hookTimeoutMs, custom watch.
test('install --yes preserves key, non-default dim, models, providers, timeout, custom watch', () => {
  write(HOSTED);
  const cfg = reinstall();
  expect(cfg.embedderApiKey).toBe('pa-secret-key-xyz');
  expect(cfg.embedder).toBe('voyage-hosted');
  expect(cfg.embedderModel).toBe('voyage-3-large');
  expect(cfg.embeddingDimension).toBe(2048);          // NOT reset to 1024
  expect(cfg.summarizer).toBe('anthropic');
  expect(cfg.summarizerModel).toBe('claude-opus-4-8'); // NOT reset to claude-haiku-4-5
  expect(cfg.hookTimeoutMs).toBe(5000);                // NOT reset to 2000
  expect(cfg.watchMemory).toBe('/custom/path/*.md');   // NOT reset to all-projects
});

// summarizer=skip is encoded as the ABSENCE of the provider line (the worker treats
// an unknown provider as "fall back to default", so a literal =skip would re-enable it).
test('summarizer=skip round-trips (absent provider line stays skip, not flipped)', () => {
  write([
    'CAPTAIN_MEMO_DATA_DIR=/home/u/.captain-memo',
    'CAPTAIN_MEMO_EMBEDDER_ENDPOINT=https://api.voyageai.com/v1/embeddings',
    'CAPTAIN_MEMO_EMBEDDER_MODEL=voyage-4-lite',
    'CAPTAIN_MEMO_EMBEDDING_DIM=1024',
    'CAPTAIN_MEMO_EMBEDDER_API_KEY=k',
    'CAPTAIN_MEMO_WATCH_MEMORY=/custom/*.md',
    // no CAPTAIN_MEMO_SUMMARIZER_PROVIDER → skip
  ]);
  expect(loadExistingConfig(envPath).summarizer).toBe('skip');
  expect(reinstall().summarizer).toBe('skip');         // NOT flipped to claude-oauth
});

// watch=skip is encoded as the ABSENCE of the watch line.
test('watch=skip round-trips (absent watch line stays skip, not flipped to all-projects)', () => {
  write([
    'CAPTAIN_MEMO_DATA_DIR=/home/u/.captain-memo',
    'CAPTAIN_MEMO_EMBEDDER_ENDPOINT=https://api.voyageai.com/v1/embeddings',
    'CAPTAIN_MEMO_EMBEDDER_MODEL=voyage-4-lite',
    'CAPTAIN_MEMO_EMBEDDING_DIM=1024',
    'CAPTAIN_MEMO_EMBEDDER_API_KEY=k',
    'CAPTAIN_MEMO_SUMMARIZER_PROVIDER=claude-oauth',
    'CAPTAIN_MEMO_SUMMARIZER_MODEL=claude-haiku-4-5',
    // no CAPTAIN_MEMO_WATCH_MEMORY → skip
  ]);
  expect(loadExistingConfig(envPath).watchMemory).toBe('');
  expect(reinstall().watchMemory).toBe('');            // NOT the all-projects glob
});

// A LOOPBACK :8124 is the local sidecar; a REMOTE :8124 is a normal openai-compatible
// endpoint and must NOT be misclassified (which would drop its endpoint/model/dim/key).
test('embedder provider inference: loopback :8124 → local-sidecar, remote :8124 → openai-compatible', () => {
  write(['CAPTAIN_MEMO_EMBEDDER_ENDPOINT=http://127.0.0.1:8124/v1/embeddings', 'CAPTAIN_MEMO_EMBEDDER_MODEL=voyageai/voyage-4-nano']);
  expect(loadExistingConfig(envPath).embedder).toBe('local-sidecar');

  write([
    'CAPTAIN_MEMO_EMBEDDER_ENDPOINT=http://gpu-box.lan:8124/v1/embeddings',
    'CAPTAIN_MEMO_EMBEDDER_MODEL=nomic-embed-text',
    'CAPTAIN_MEMO_EMBEDDING_DIM=768',
    'CAPTAIN_MEMO_EMBEDDER_API_KEY=remote-key',
  ]);
  const c = loadExistingConfig(envPath);
  expect(c.embedder).toBe('openai-compatible');
  const cfg = reinstall();
  expect(cfg.embedderEndpoint).toBe('http://gpu-box.lan:8124/v1/embeddings'); // preserved, not reverted to sidecar default
  expect(cfg.embedderApiKey).toBe('remote-key');
  expect(cfg.embeddingDimension).toBe(768);
});

test('loadExistingConfig strips surrounding quotes but not a lone quote', () => {
  write(['CAPTAIN_MEMO_EMBEDDER_ENDPOINT="https://api.voyageai.com/v1/embeddings"', 'CAPTAIN_MEMO_EMBEDDER_API_KEY=\'quoted-key\'']);
  const c = loadExistingConfig(envPath);
  expect(c.embedderEndpoint).toBe('https://api.voyageai.com/v1/embeddings');
  expect(c.embedderApiKey).toBe('quoted-key');
});

test('missing worker.env → empty config (fresh install, no key invented)', () => {
  expect(loadExistingConfig(join(dir, 'does-not-exist.env'))).toEqual({});
  expect(gatherConfig({}, { nonInteractive: true } as any).embedderApiKey ?? '').toBe('');
});
