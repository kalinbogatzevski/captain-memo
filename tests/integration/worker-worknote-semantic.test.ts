// E2E: the SEMANTIC half of the work board. Two sessions on the same INTENT but DIFFERENT files share no glob,
// so file overlap is blind to them — the semantic pass must catch them. Boots a real worker against a fake
// embedder (keyword → vector) and proves a cross-file, meaning-only overlap surfaces (eventually-consistent).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';

// Fake embedder: "billing" texts map to near-parallel vectors (cosine ≈ 0.99); "map" is orthogonal. Dim 8.
function vecFor(text: string): number[] {
  const t = text.toLowerCase();
  if (t.includes('billing')) return t.includes('pro-ration') ? [0.98, 0.2, 0, 0, 0, 0, 0, 0] : [1, 0, 0, 0, 0, 0, 0, 0];
  if (t.includes('map')) return [0, 1, 0, 0, 0, 0, 0, 0];
  return [0, 0, 1, 0, 0, 0, 0, 0];
}
let embedSrv: ReturnType<typeof Bun.serve>;
let worker: WorkerHandle;
let port = 0;

beforeAll(async () => {
  embedSrv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { input: string[] };
      const data = body.input.map((text, index) => ({ index, embedding: vecFor(text) }));
      return Response.json({ data });
    },
  });
  worker = await startWorker({
    port: 0,
    projectId: 'test-project',
    metaDbPath: ':memory:',
    embedderEndpoint: `http://localhost:${embedSrv.port}/embed`,
    embedderModel: 'fake',
    vectorDbPath: ':memory:',
    embeddingDimension: 8,
    skipEmbed: true,
  });
  port = worker.port;
});
afterAll(async () => { await worker.stop(); await embedSrv.stop(true); });

async function setNote(b: Record<string, unknown>) {
  const res = await fetch(`http://localhost:${port}/worknote/set`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
  });
  return (await res.json()) as { overlaps: Array<{ session_id: string; kind?: string; similarity?: number; overlapping: string[] }> };
}

test('two sessions on the same INTENT in DIFFERENT files get a semantic overlap (file pass is blind to it)', async () => {
  await setNote({ session_id: 'A', agent: 'claude', what: 'refactor the billing module', files: ['billing/charge.ts'] });
  // B shares NO files with A. The only signal is meaning. First call warms the cache (mine not embedded yet ⇒ []).
  const first = await setNote({ session_id: 'B', agent: 'codex', what: 'rework billing pro-ration', files: ['invoice/proration.ts'] });
  expect(first.overlaps.find((o) => o.session_id === 'A' && o.kind === 'semantic')).toBeUndefined();

  // Eventually-consistent: re-publish B until the warmed vectors land and the semantic overlap surfaces.
  let hit: { similarity?: number; overlapping: string[] } | undefined;
  for (let i = 0; i < 40 && !hit; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const r = await setNote({ session_id: 'B', agent: 'codex', what: 'rework billing pro-ration', files: ['invoice/proration.ts'] });
    hit = r.overlaps.find((o) => o.session_id === 'A' && o.kind === 'semantic');
  }
  expect(hit).toBeDefined();
  expect(hit!.overlapping).toEqual([]);            // purely semantic — no shared files
  expect(hit!.similarity).toBeGreaterThan(0.8);
});

test('two sessions on UNRELATED intents in different files get NO overlap', async () => {
  await setNote({ session_id: 'C', agent: 'claude', what: 'refactor the billing module', files: ['billing/x.ts'] });
  let sawSemantic = false;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const r = await setNote({ session_id: 'D', agent: 'codex', what: 'fix the map tile loader', files: ['geo/tiles.ts'] });
    if (r.overlaps.some((o) => o.session_id === 'C' && o.kind === 'semantic')) sawSemantic = true;
  }
  expect(sawSemantic).toBe(false);
});

test('REGRESSION: two GENERIC un-enriched claims (no observation) never false-match semantically', async () => {
  // This worker has no observations DB ⇒ enrichment can't apply ⇒ both claims keep the hook's generic placeholder
  // and are NOT meaningful. Their `what` is byte-identical (same project, same file count) so a naive pass would
  // score cosine 1.0 and fire a bogus "same thing by meaning". The intent gate must keep them out entirely.
  const generic = (sid: string, file: string) => ({
    session_id: sid, agent: 'claude', what: 'editing 2 file(s) in repoX', files: [file], enrich_from_observations: true,
  });
  await setNote(generic('GA', 'billing/charge.ts'));
  let sawSemantic = false;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const r = await setNote(generic('GB', 'invoice/proration.ts'));   // different files ⇒ no file overlap either
    if (r.overlaps.some((o) => o.session_id === 'GA' && o.kind === 'semantic')) sawSemantic = true;
  }
  expect(sawSemantic).toBe(false);
});
