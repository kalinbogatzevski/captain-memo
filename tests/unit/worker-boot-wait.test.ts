// The shared boot wait (tests/support/worker-boot.ts) must not turn a crashed worker into a 90 s wait on Windows:
// a process that exits before /health answers fails at once, with its stderr.
import { test, expect } from 'bun:test';
import { tailOf, waitHealthy } from '../support/worker-boot.ts';

test('a worker that exits before /health answers fails at once, naming its exit code and stderr', async () => {
  const proc = Bun.spawn(['bun', '-e', 'console.error("boot failed: disk full"); process.exit(3)'], { stdout: 'ignore', stderr: 'pipe' });
  const t0 = Date.now();
  const err = await waitHealthy('http://127.0.0.1:1', proc, tailOf(proc.stderr)).then(() => null, (e: Error) => e);
  expect(err?.message).toContain('exited with code 3');
  expect(err?.message).toContain('boot failed: disk full');
  expect(Date.now() - t0).toBeLessThan(10_000);
}, 20_000);

test('a worker that accepts /health but never answers still fails with its stderr tail at the budget', async () => {
  const srv = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
  try {
    const err = await waitHealthy(`http://127.0.0.1:${srv.port}`, { exited: new Promise<number>(() => {}) }, () => 'last stderr line', 1_000).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('never healthy within 1000 ms');
    expect(err?.message).toContain('last stderr line');
  } finally { srv.stop(true); }
}, 10_000);
