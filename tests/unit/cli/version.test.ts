// #974: `captain-memo --version` and `captain-memo version` answered "Unknown command" (exit 2). Both print the number the CLI
// banner and /stats print (shared/version.ts), exit 0, and never call the worker. Runs the real CLI entry against a stub worker.
import { test, expect, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { VERSION } from '../../../src/shared/version.ts';

const hits: string[] = [];
const stub = Bun.serve({ port: 0, fetch: (req) => { hits.push(new URL(req.url).pathname); return Response.json({ healthy: true }); } });
const dataDir = mkdtempSync(join(tmpdir(), 'cm-ver-'));
afterAll(() => { stub.stop(true); rmSync(dataDir, { recursive: true, force: true }); });

const CLI = join(import.meta.dir, '../../../src/cli/index.ts');
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(['bun', CLI, ...args], {
    env: { ...process.env, CAPTAIN_MEMO_WORKER_PORT: String(stub.port), CAPTAIN_MEMO_DATA_DIR: dataDir, CAPTAIN_MEMO_CONFIG_DIR: dataDir, NO_COLOR: '1' },
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

for (const spelling of ['--version', 'version']) {
  test(`captain-memo ${spelling} prints the version, exits 0 and never touches the worker`, async () => {
    hits.length = 0;
    const r = await run([spelling]);
    expect(r.out.trim()).toBe(`captain-memo ${VERSION}`);
    expect(r.err).not.toMatch(/Unknown command/);
    expect(r.code).toBe(0);
    expect(hits).toEqual([]);
  }, 20_000);
}
