// tests/integration/backup-restore.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { createBackup } from '../../src/services/backup/create.ts';
import { restoreBackup, RestoreError } from '../../src/services/backup/restore.ts';

let root: string, dataDir: string, configDir: string, outDir: string;
let prevData: string | undefined, prevConfig: string | undefined, prevPort: string | undefined;

function seedCorpus(dir: string, chunks: number, obs: number) {
  mkdirSync(dir, { recursive: true });
  const meta = new Database(join(dir, 'meta.sqlite3'));
  meta.exec('PRAGMA journal_mode = WAL;');
  meta.exec('CREATE TABLE documents(id INTEGER PRIMARY KEY);');
  meta.exec('CREATE TABLE chunks(id INTEGER PRIMARY KEY, text TEXT);');
  for (let i = 0; i < chunks; i++) meta.exec("INSERT INTO chunks(text) VALUES ('x');");
  meta.close();
  const o = new Database(join(dir, 'observations.db'));
  o.exec('PRAGMA journal_mode = WAL;');
  o.exec('CREATE TABLE observations(id INTEGER PRIMARY KEY);');
  for (let i = 0; i < obs; i++) o.exec('INSERT INTO observations(id) VALUES (NULL);');
  o.close();
}

beforeEach(() => {
  prevData = process.env.CAPTAIN_MEMO_DATA_DIR;
  prevConfig = process.env.CAPTAIN_MEMO_CONFIG_DIR;
  prevPort = process.env.CAPTAIN_MEMO_WORKER_PORT;
  // Dead worker port → restore's best-effort GET /stats fails fast to the env
  // fallback; keeps the test hermetic and off whatever live worker is running.
  process.env.CAPTAIN_MEMO_WORKER_PORT = '1';
  root = mkdtempSync(join(tmpdir(), 'cm-restore-'));
  outDir = join(root, 'out'); mkdirSync(outDir, { recursive: true });
});
afterEach(() => {
  if (prevData === undefined) delete process.env.CAPTAIN_MEMO_DATA_DIR; else process.env.CAPTAIN_MEMO_DATA_DIR = prevData;
  if (prevConfig === undefined) delete process.env.CAPTAIN_MEMO_CONFIG_DIR; else process.env.CAPTAIN_MEMO_CONFIG_DIR = prevConfig;
  if (prevPort === undefined) delete process.env.CAPTAIN_MEMO_WORKER_PORT; else process.env.CAPTAIN_MEMO_WORKER_PORT = prevPort;
});

function useDataDir(name: string) {
  dataDir = join(root, name); configDir = join(root, name + '-cfg');
  mkdirSync(configDir, { recursive: true });
  process.env.CAPTAIN_MEMO_DATA_DIR = dataDir;
  process.env.CAPTAIN_MEMO_CONFIG_DIR = configDir;
}

test('round-trip: backup a corpus, restore into an empty install, counts survive', async () => {
  useDataDir('src');
  writeFileSync(join(configDir, 'worker.env'), 'ANTHROPIC_API_KEY=sk\n');
  seedCorpus(dataDir, 5, 4);
  const out = join(outDir, 'b.tar.gz');
  await createBackup({ outPath: out, includeVectors: false });

  useDataDir('dst');                          // fresh empty install
  const res = await restoreBackup(out, { startWorker: false });
  expect(res.counts.chunks).toBe(5);
  expect(res.counts.observations).toBe(4);
  expect(existsSync(join(dataDir, 'meta.sqlite3'))).toBe(true);
  expect(existsSync(join(configDir, 'worker.env'))).toBe(true);
}, 20000);

test('refuses a non-empty target without force, then a pre-restore copy is kept with force', async () => {
  useDataDir('src2');
  seedCorpus(dataDir, 3, 0);
  const out = join(outDir, 'c.tar.gz');
  await createBackup({ outPath: out, includeVectors: false });

  useDataDir('dst2');
  seedCorpus(dataDir, 99, 0);                 // already populated
  await expect(restoreBackup(out, { startWorker: false })).rejects.toBeInstanceOf(RestoreError);

  const res = await restoreBackup(out, { force: true, startWorker: false });
  expect(res.counts.chunks).toBe(3);          // replaced
  expect(res.preRestoreDir).not.toBeNull();
  expect(existsSync(join(res.preRestoreDir!, 'meta.sqlite3'))).toBe(true); // old corpus recoverable
}, 20000);

test('a corrupted archive aborts with zero changes to the target', async () => {
  useDataDir('dst3');
  seedCorpus(dataDir, 7, 0);
  const bad = join(outDir, 'bad.tar.gz');
  writeFileSync(bad, 'not a real archive');
  await expect(restoreBackup(bad, { force: true, startWorker: false })).rejects.toThrow();
  // untouched
  const meta = new Database(join(dataDir, 'meta.sqlite3'), { readonly: true });
  expect((meta.query('SELECT count(*) AS n FROM chunks').get() as { n: number }).n).toBe(7);
  meta.close();
  expect(readdirSync(dataDir).some((n) => n.startsWith('.pre-restore'))).toBe(false);
}, 20000);

test('restore preserves the target existing config.json + worker.env into .pre-restore', async () => {
  useDataDir('src4');
  writeFileSync(join(configDir, 'worker.env'), 'ANTHROPIC_API_KEY=NEW-FROM-BACKUP\n');
  seedCorpus(dataDir, 2, 0);
  const out = join(outDir, 'e.tar.gz');
  await createBackup({ outPath: out, includeVectors: false });

  useDataDir('dst4');
  seedCorpus(dataDir, 9, 0);
  writeFileSync(join(configDir, 'worker.env'), 'ANTHROPIC_API_KEY=OLD-ON-TARGET\n');
  writeFileSync(join(dataDir, 'config.json'), '{"old":true}');

  const res = await restoreBackup(out, { force: true, startWorker: false });
  // restored secrets are now in place
  expect(await Bun.file(join(configDir, 'worker.env')).text()).toContain('NEW-FROM-BACKUP');
  // the target's ORIGINAL secrets + config are preserved recoverably
  expect(res.preRestoreDir).not.toBeNull();
  expect(existsSync(join(res.preRestoreDir!, 'worker.env'))).toBe(true);
  expect(await Bun.file(join(res.preRestoreDir!, 'worker.env')).text()).toContain('OLD-ON-TARGET');
  expect(existsSync(join(res.preRestoreDir!, 'config.json'))).toBe(true);
  expect(res.workerEnvDest).toBe(join(configDir, 'worker.env'));
}, 20000);
