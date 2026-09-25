// E2E: the ENRICHMENT mechanism the whole feature leans on. A hook claim arrives with the generic placeholder
// `what` + enrich_from_observations; the worker must swap in the session's latest observation TITLE (its real
// meaning) and mark the claim meaningful so it joins the semantic pass. Boots a worker over a file-backed
// observations DB seeded with one observation.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { ObservationsStore } from '../../src/worker/observations-store.ts';

let workDir: string;
let worker: WorkerHandle;
let port = 0;
const TITLE = 'Wire the billing gateway into the portal';

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-wn-enrich-'));
  const obsPath = join(workDir, 'observations.db');
  // Seed one observation for session ES, then close our handle before the worker opens its own.
  const seed = new ObservationsStore(obsPath);
  seed.insert({
    session_id: 'ES', project_id: 'p1', prompt_number: 1, type: 'feature',
    title: TITLE, narrative: 'n', facts: [], concepts: [], files_read: [], files_modified: [],
    created_at_epoch: 1_700_000_000, branch: null, origin_agent: null, work_tokens: null,
  });
  seed.close();
  worker = await startWorker({
    port: 0, projectId: 'p1', metaDbPath: ':memory:',
    observationsDbPath: obsPath,
    embedderEndpoint: 'http://localhost:0/unused', embedderModel: 'fake',
    vectorDbPath: ':memory:', embeddingDimension: 8, skipEmbed: true,
  });
  port = worker.port;
});
afterAll(async () => { await worker.stop(); rmSync(workDir, { recursive: true, force: true }); });

test('a generic hook claim with enrich_from_observations gets its `what` replaced by the latest observation title', async () => {
  await fetch(`http://localhost:${port}/worknote/set`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'ES', agent: 'claude', what: 'editing 1 file(s) in p1', files: ['gw/a.ts'], enrich_from_observations: true }),
  });
  const res = await fetch(`http://localhost:${port}/worknote/active?session_id=ES`);
  const body = (await res.json()) as { claims: Array<{ session_id: string; what: string; meaningful?: boolean }> };
  const mine = body.claims.find((c) => c.session_id === 'ES');
  expect(mine).toBeDefined();
  expect(mine!.what).toBe(TITLE);            // swapped from the generic placeholder to the real observation title
  expect(mine!.meaningful).toBe(true);       // and marked meaningful, so it now joins the semantic pass
});

test('a claim from a session with NO observation keeps the generic placeholder and is not meaningful', async () => {
  await fetch(`http://localhost:${port}/worknote/set`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'NOOBS', agent: 'claude', what: 'editing 1 file(s) in p1', files: ['x/a.ts'], enrich_from_observations: true }),
  });
  const res = await fetch(`http://localhost:${port}/worknote/active?session_id=NOOBS`);
  const body = (await res.json()) as { claims: Array<{ session_id: string; what: string; meaningful?: boolean }> };
  const mine = body.claims.find((c) => c.session_id === 'NOOBS');
  expect(mine!.what).toBe('editing 1 file(s) in p1');   // unchanged
  expect(mine!.meaningful).toBeUndefined();             // not meaningful ⇒ excluded from semantic
});

// An explicit work_set (topics + a stated `what`) used to be overwritten by the very next hook auto-claim, so the
// board went back to "untitled work". The auto-claim now keeps the declared intent while the declaration is live.
test('a hook auto-claim after work_set keeps the declared topics and what (even when an observation exists)', async () => {
  const post = (b: unknown) => fetch(`http://localhost:${port}/worknote/set`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const active = async () => ((await (await fetch(`http://localhost:${port}/worknote/active?session_id=ES`)).json()) as { claims: Array<{ session_id: string; what: string; topics?: string[]; meaningful?: boolean; declared_until?: number }> }).claims.find((c) => c.session_id === 'ES')!;
  const before = Date.now();
  await post({ session_id: 'ES', agent: 'claude', what: 'wiring the billing gateway', topics: ['billing-gateway'], files: ['gw/**'], ttl_s: 120 });
  const after = Date.now();
  // The declaration lasts the work_set's own lease, in epoch-ms.
  const until = (await active()).declared_until!;
  expect(until).toBeGreaterThanOrEqual(before + 120_000);
  expect(until).toBeLessThanOrEqual(after + 120_000);
  const set = await (await post({ session_id: 'ES', agent: 'claude', what: 'editing 1 file(s) in p1', files: ['gw/b.ts'], enrich_from_observations: true })).json() as { topics: string[] };
  expect(set.topics).toEqual(['billing-gateway']);
  const mine = await active();
  expect(mine.declared_until).toBe(until);   // the edit heartbeat never extends the declaration
  expect(mine.what).toBe('wiring the billing gateway');   // the declared what, not the observation title
  expect(mine.topics).toEqual(['billing-gateway']);
  expect(mine.meaningful).toBe(true);
  // A new explicit work_set is a new declaration: it replaces the old one.
  await post({ session_id: 'ES', agent: 'claude', what: 'now the invoices', topics: ['invoices'] });
  const again = (await (await fetch(`http://localhost:${port}/worknote/active?session_id=ES`)).json()) as { claims: Array<{ session_id: string; what: string; topics?: string[] }> };
  expect(again.claims.find((c) => c.session_id === 'ES')!.topics).toEqual(['invoices']);
});
