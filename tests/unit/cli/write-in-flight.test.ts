// threaded-main answers 202 {status:'write_in_flight'} when its thread RPC times out on an IN_FLIGHT path.
// Every CLI caller must say UNCONFIRMED (never "complete", never undefined counts, never "failed").
// Runs the real CLI entry against a stub worker, so the top-level reportCliError path is covered too.
import { test, expect, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const hits: string[] = [];
const stub = Bun.serve({
  port: 0,
  fetch: (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/health') return Response.json({ healthy: true });
    hits.push(p);
    return Response.json({ status: 'write_in_flight', detail: 'x', hint: 'y' }, { status: 202 });
  },
});
afterAll(() => { stub.stop(true); rmSync(dataDir, { recursive: true, force: true }); });
const dataDir = mkdtempSync(join(tmpdir(), 'cm-wif-'));   // upgrade opens meta.sqlite3 before it calls the worker

const CLI = join(import.meta.dir, '../../../src/cli/index.ts');
async function run(args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(['bun', CLI, ...args], {
    // No user bus: if a regression let upgrade reach its VACUUM phase, `systemctl --user stop` must fail here rather
    // than stop this machine's real worker. CONFIG_DIR is pinned too, so no real worker token is read or sent.
    env: { ...process.env, CAPTAIN_MEMO_WORKER_PORT: String(stub.port), CAPTAIN_MEMO_DATA_DIR: dataDir, CAPTAIN_MEMO_CONFIG_DIR: dataDir, NO_COLOR: '1',
      XDG_RUNTIME_DIR: dataDir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent' },
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: o + e };
}

const neverClaimsDone = (out: string) => {
  expect(out).toMatch(/UNCONFIRMED/);
  expect(out).not.toMatch(/undefined|Reindex complete|Upgrade complete|remember failed|request failed|no candidates left/i);
};

test('remember: UNCONFIRMED, exit 0 (no retry-inviting failure)', async () => {
  const r = await run(['remember', '--type', 'decision', '--body', 'x']);
  neverClaimsDone(r.out);
  expect(r.out).toMatch(/Do NOT retry/);
  expect(r.code).toBe(0);
}, 20_000);

test('reindex: UNCONFIRMED, exit 2, no "Reindex complete"', async () => {
  const r = await run(['reindex']);
  neverClaimsDone(r.out);
  // the 202 for /reindex comes after main waited 30 min with the pass still running: never "finished"
  expect(r.out).toMatch(/may still be running/);
  expect(r.out).not.toMatch(/most likely/);
  expect(r.out).toMatch(/no progress readout/);                              // per-path hint, not a memory search
  expect(r.out).not.toMatch(/search_memory|captain-memo status/);
  expect(r.code).toBe(2);
}, 20_000);

test('promote --shadow: stops after the unconfirmed slice, exit 2', async () => {
  hits.length = 0;
  const r = await run(['promote', '--shadow', '--slices', '3']);
  neverClaimsDone(r.out);
  expect(hits.filter((h) => h === '/promote/slice')).toHaveLength(1);
  expect(r.out).toMatch(/promote --report/);
  expect(r.code).toBe(2);
}, 20_000);

test('consolidate: UNCONFIRMED instead of a crash on the missing started list, exit 2', async () => {
  const r = await run(['consolidate']);
  neverClaimsDone(r.out);
  expect(r.out).not.toMatch(/TypeError/);
  expect(r.code).toBe(2);
}, 20_000);

test('upgrade --force: UNCONFIRMED, exit 2, and the worker is not stopped for VACUUM mid-reindex', async () => {
  hits.length = 0;
  const r = await run(['upgrade', '--force']);
  neverClaimsDone(r.out);
  expect(r.out).not.toMatch(/Stopping worker|indexed:/);
  expect(hits).not.toContain('/shutdown');
  expect(r.code).toBe(2);
}, 20_000);
