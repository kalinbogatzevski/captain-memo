// tests/integration/backup-command.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { backupCommand } from '../../src/cli/commands/backup.ts';

let root: string, outDir: string;
let prevData: string | undefined, prevConfig: string | undefined, prevPort: string | undefined;

async function capture(fn: () => Promise<number>): Promise<{ out: string; code: number }> {
  const origLog = console.log, origErr = console.error;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  let code = 0;
  try { code = await fn(); } finally { console.log = origLog; console.error = origErr; }
  return { out: lines.join('\n'), code };
}

function seed(dir: string) {
  mkdirSync(dir, { recursive: true });
  const meta = new Database(join(dir, 'meta.sqlite3'));
  meta.exec('CREATE TABLE documents(id INTEGER PRIMARY KEY);');
  meta.exec('CREATE TABLE chunks(id INTEGER PRIMARY KEY, text TEXT);');
  meta.exec("INSERT INTO chunks(text) VALUES ('a'),('b');");
  meta.close();
  const o = new Database(join(dir, 'observations.db'));
  o.exec('CREATE TABLE observations(id INTEGER PRIMARY KEY);');
  o.close();
}

beforeEach(() => {
  prevData = process.env.CAPTAIN_MEMO_DATA_DIR; prevConfig = process.env.CAPTAIN_MEMO_CONFIG_DIR;
  prevPort = process.env.CAPTAIN_MEMO_WORKER_PORT;
  process.env.CAPTAIN_MEMO_WORKER_PORT = '1'; // dead port → /stats probe fails fast to env fallback
  root = mkdtempSync(join(tmpdir(), 'cm-cmd-'));
  outDir = join(root, 'out'); mkdirSync(outDir, { recursive: true });
  process.env.CAPTAIN_MEMO_DATA_DIR = join(root, 'data');
  process.env.CAPTAIN_MEMO_CONFIG_DIR = join(root, 'cfg');
  mkdirSync(process.env.CAPTAIN_MEMO_CONFIG_DIR, { recursive: true });
  seed(process.env.CAPTAIN_MEMO_DATA_DIR);
});
afterEach(() => {
  if (prevData === undefined) delete process.env.CAPTAIN_MEMO_DATA_DIR; else process.env.CAPTAIN_MEMO_DATA_DIR = prevData;
  if (prevConfig === undefined) delete process.env.CAPTAIN_MEMO_CONFIG_DIR; else process.env.CAPTAIN_MEMO_CONFIG_DIR = prevConfig;
  if (prevPort === undefined) delete process.env.CAPTAIN_MEMO_WORKER_PORT; else process.env.CAPTAIN_MEMO_WORKER_PORT = prevPort;
});

test('unknown subcommand prints usage and exits 2', async () => {
  const { out, code } = await capture(() => backupCommand(['frobnicate']));
  expect(code).toBe(2);
  expect(out).toMatch(/create|restore|info/);
});

test('create then info round-trips through the CLI', async () => {
  const out = join(outDir, 'b.tar.gz');
  const c = await capture(() => backupCommand(['create', '--out', out, '--no-vectors']));
  expect(c.code).toBe(0);
  expect(existsSync(out)).toBe(true);
  expect(c.out).toMatch(/API keys|secrets/i);  // the loud warning (worker.env may be absent → still safe)

  const i = await capture(() => backupCommand(['info', out]));
  expect(i.code).toBe(0);
  expect(i.out).toMatch(/chunks/);
}, 20000);
