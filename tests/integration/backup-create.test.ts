// tests/integration/backup-create.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { createBackup } from '../../src/services/backup/create.ts';
import { readManifestFromArchive, extractArchive } from '../../src/services/backup/snapshot.ts';

let dataDir: string, configDir: string, outDir: string;
let prevData: string | undefined, prevConfig: string | undefined;

function seedCorpus(dir: string) {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'vector-db'), { recursive: true });
  // meta.sqlite3 with 1 document + 2 chunks
  const meta = new Database(join(dir, 'meta.sqlite3'));
  meta.exec('PRAGMA journal_mode = WAL;');
  meta.exec('CREATE TABLE documents(id INTEGER PRIMARY KEY);');
  meta.exec('CREATE TABLE chunks(id INTEGER PRIMARY KEY, text TEXT);');
  meta.exec("INSERT INTO documents(id) VALUES (1);");
  meta.exec("INSERT INTO chunks(text) VALUES ('a'),('b');");
  meta.close();
  // observations.db with 3 rows
  const obs = new Database(join(dir, 'observations.db'));
  obs.exec('PRAGMA journal_mode = WAL;');
  obs.exec('CREATE TABLE observations(id INTEGER PRIMARY KEY);');
  obs.exec('INSERT INTO observations(id) VALUES (1),(2),(3);');
  obs.close();
  // a transient db that must NOT be in the archive
  const q = new Database(join(dir, 'queue.db'));
  q.exec('CREATE TABLE q(x);'); q.close();
  writeFileSync(join(dir, 'federation.json'), '{"peer":"secret"}');
}

beforeEach(() => {
  prevData = process.env.CAPTAIN_MEMO_DATA_DIR;
  prevConfig = process.env.CAPTAIN_MEMO_CONFIG_DIR;
  const root = mkdtempSync(join(tmpdir(), 'cm-backup-'));
  dataDir = join(root, 'data'); configDir = join(root, 'config'); outDir = join(root, 'out');
  mkdirSync(configDir, { recursive: true }); mkdirSync(outDir, { recursive: true });
  process.env.CAPTAIN_MEMO_DATA_DIR = dataDir;
  process.env.CAPTAIN_MEMO_CONFIG_DIR = configDir;
  writeFileSync(join(configDir, 'worker.env'), 'ANTHROPIC_API_KEY=sk-test\n');
  seedCorpus(dataDir);
});
afterEach(() => {
  if (prevData === undefined) delete process.env.CAPTAIN_MEMO_DATA_DIR; else process.env.CAPTAIN_MEMO_DATA_DIR = prevData;
  if (prevConfig === undefined) delete process.env.CAPTAIN_MEMO_CONFIG_DIR; else process.env.CAPTAIN_MEMO_CONFIG_DIR = prevConfig;
});

test('createBackup writes an archive with correct counts and durable files only', async () => {
  const out = join(outDir, 'b.tar.gz');
  const res = await createBackup({ outPath: out, includeVectors: false });
  expect(existsSync(out)).toBe(true);
  expect(res.manifest.counts.chunks).toBe(2);
  expect(res.manifest.counts.observations).toBe(3);
  expect(res.manifest.includes_secrets).toBe(true);
  expect(res.manifest.includes_vectors).toBe(false);
  // chmod 600 on POSIX
  if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o600);

  const back = join(outDir, 'back'); mkdirSync(back, { recursive: true });
  await extractArchive(out, back);
  expect(existsSync(join(back, 'data', 'meta.sqlite3'))).toBe(true);
  expect(existsSync(join(back, 'data', 'observations.db'))).toBe(true);
  expect(existsSync(join(back, 'config', 'worker.env'))).toBe(true);
  // Excluded:
  expect(existsSync(join(back, 'data', 'queue.db'))).toBe(false);
  expect(existsSync(join(back, 'data', 'federation.json'))).toBe(false);

  const man = await readManifestFromArchive(out);
  expect(man.captain_memo_version.length).toBeGreaterThan(0);
});

test('createBackup leaves no .partial file behind on success', async () => {
  const out = join(outDir, 'c.tar.gz');
  await createBackup({ outPath: out, includeVectors: false });
  expect(existsSync(out + '.partial')).toBe(false);
});
