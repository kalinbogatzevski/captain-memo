// readWorkerInstance — the identity `captain-memo restart` polls for must be readable while the writer is
// still buried in the startup indexing burst (field 2026-09-19: /stats 503s for longer than the restart
// window on a 34k-chunk captain, so every successful restart was reported as unconfirmed).
import { test, expect } from 'bun:test';
import { readWorkerInstance } from '../../src/shared/worker-health-probe.ts';

function fakeWorker(health: () => Response, stats: () => Response) {
  return Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === '/health' ? health() : stats()) });
}

test('a warming worker (503 /health carrying `instance`, /stats 503) is still identified', async () => {
  const srv = fakeWorker(
    () => Response.json({ healthy: false, degraded: 'engine unresponsive', instance: 4242 }, { status: 503 }),
    () => Response.json({ error: 'engine_unavailable' }, { status: 503 }),
  );
  try { expect(await readWorkerInstance(srv.port!, 1000)).toBe(4242); } finally { srv.stop(true); }
});

test('an older worker with no `instance` on /health falls back to /stats worker.started_at_epoch', async () => {
  const srv = fakeWorker(() => Response.json({ healthy: true }), () => Response.json({ worker: { started_at_epoch: 77 } }));
  try { expect(await readWorkerInstance(srv.port!, 1000)).toBe(77); } finally { srv.stop(true); }
});

test('no identity anywhere (old worker, /stats busy) reads as null', async () => {
  const srv = fakeWorker(() => Response.json({ healthy: true }), () => Response.json({ error: 'writer busy' }, { status: 503 }));
  try { expect(await readWorkerInstance(srv.port!, 1000)).toBeNull(); } finally { srv.stop(true); }
});

test('nothing listening reads as null', async () => {
  const srv = Bun.serve({ port: 0, fetch: () => new Response('') }); const port = srv.port!; srv.stop(true);
  expect(await readWorkerInstance(port, 500)).toBeNull();
});
