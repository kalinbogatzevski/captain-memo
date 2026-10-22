// The worker refuses a second /reindex with 409 reindex_running (single-flight). Every CLI caller of /reindex (reindex,
// upgrade, reindex --redim) must say what the worker said — with the start time — and not print the raw
// `/reindex → 409: {json}` line; and upgrade must stop before it can VACUUM under the running pass.
// Runs the real CLI entry against a stub worker, so the top-level reportCliError path is covered.
import { test, expect, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const DETAIL = 'a reindex is already running, started 09:51:48, wait for it';
const hits: string[] = [];
const stub = Bun.serve({
  port: 0,
  fetch: (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/health') return Response.json({ healthy: true });
    hits.push(p);
    return Response.json({ error: 'reindex_running', started_at: '2026-10-22T06:51:48.000Z', channel: 'all', force: true, detail: DETAIL }, { status: 409 });
  },
});
const dataDir = mkdtempSync(join(tmpdir(), 'cm-rr409-'));   // upgrade opens meta.sqlite3 before it calls the worker
afterAll(() => { stub.stop(true); rmSync(dataDir, { recursive: true, force: true }); });

const CLI = join(import.meta.dir, '../../../src/cli/index.ts');
async function run(args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(['bun', CLI, ...args], {
    // No user bus: a regression that let upgrade reach VACUUM must fail here, not stop this machine's real worker.
    env: { ...process.env, CAPTAIN_MEMO_WORKER_PORT: String(stub.port), CAPTAIN_MEMO_DATA_DIR: dataDir, CAPTAIN_MEMO_CONFIG_DIR: dataDir, NO_COLOR: '1',
      XDG_RUNTIME_DIR: dataDir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent' },
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: o + e };
}

test('reindex: prints the worker\'s sentence with the start time, exit 1, no "Reindex complete", no raw JSON', async () => {
  const r = await run(['reindex', '--force']);
  expect(r.out.trim()).toBe(DETAIL);
  expect(r.out).not.toMatch(/Reindex complete|undefined|409|reindex_running|\{/);
  expect(r.code).toBe(1);
}, 20_000);

test('upgrade --force: same sentence, exit 1, and the worker is not stopped for VACUUM under the running pass', async () => {
  hits.length = 0;
  const r = await run(['upgrade', '--force']);
  expect(r.out.trim().split('\n').pop()).toBe(DETAIL);        // the sentence, as the last line, not the raw 409 JSON
  expect(r.out).not.toMatch(/reindex_running|409|\{/);
  expect(r.out).not.toMatch(/Stopping worker|Upgrade complete|indexed:/);
  expect(hits).toEqual(['/reindex']);                       // it asked once, then stopped
  expect(r.code).toBe(1);
}, 20_000);
