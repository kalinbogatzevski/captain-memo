import { test, expect, beforeAll, afterAll } from 'bun:test';
import { ChromaClient } from '../../src/worker/chroma.ts';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dataDir: string;
let client: ChromaClient;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aelita-chroma-test-'));
  client = new ChromaClient({ dataDir });
  await client.connect();
});

afterAll(async () => {
  await client.close();
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
});

test('ChromaClient — connects and creates a collection', async () => {
  await client.ensureCollection('aelita_test');
  // Idempotent — second call should not throw
  await client.ensureCollection('aelita_test');
});

test('ChromaClient — adds and queries documents by text', async () => {
  await client.ensureCollection('aelita_test_query');
  await client.add('aelita_test_query', [
    // embedding field is accepted by the interface (future Voyage path); chroma-mcp embeds internally
    { id: 'chunk-a', embedding: [], document: 'apple is a sweet red fruit', metadata: { kind: 'fruit' } },
    { id: 'chunk-b', embedding: [], document: 'car is a motor vehicle for transport', metadata: { kind: 'vehicle' } },
  ]);
  // Query by text — chroma-mcp embeds query_texts with its own model
  const results = await client.query('aelita_test_query', 'sweet edible fruit', 2);
  expect(results.length).toBeGreaterThan(0);
  expect(results[0]!.id).toBe('chunk-a'); // "apple fruit" semantically closest to "sweet edible fruit"
});

test('ChromaClient — deletes by id', async () => {
  await client.ensureCollection('aelita_test_delete');
  await client.add('aelita_test_delete', [
    { id: 'd1', embedding: [], document: 'first document about fruits', metadata: { kind: 'fruit' } },
    { id: 'd2', embedding: [], document: 'second document about vehicles', metadata: { kind: 'vehicle' } },
  ]);
  await client.delete('aelita_test_delete', ['d1']);
  const results = await client.query('aelita_test_delete', 'document', 5);
  expect(results.find(r => r.id === 'd1')).toBeUndefined();
  expect(results.find(r => r.id === 'd2')).toBeDefined();
});
