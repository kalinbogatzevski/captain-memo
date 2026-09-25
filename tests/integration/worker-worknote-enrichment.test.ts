// E2E: the ENRICHMENT mechanism the whole feature leans on. A hook claim arrives with the generic placeholder
// `what` + enrich_from_observations; the worker must swap in the session's latest observation TITLE (its real
// meaning) and mark the claim meaningful so it joins the semantic pass. Boots a worker over a file-backed
// observations DB seeded with one observation.
import { test, expect, beforeAll, afterAll, setSystemTime } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { detectRepoRootSync } from '../../src/worker/branch.ts';
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

// work_clear used to answer {ok:true} whether or not it removed anything, so a caller clearing a claim this captain
// did not hold was told it had worked. And a claim read off the board carries its heartbeat age (age_s).
test('/worknote/clear says whether it cleared anything; /worknote/active carries each claim\'s age_s', async () => {
  await fetch(`http://localhost:${port}/worknote/set`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'CLR', agent: 'claude', what: 'x', files: ['c/a.ts'] }),
  });
  const board = (await (await fetch(`http://localhost:${port}/worknote/active`)).json()) as { claims: Array<{ session_id: string; age_s?: number; stale?: boolean }> };
  const c = board.claims.find((x) => x.session_id === 'CLR')!;
  expect(typeof c.age_s).toBe('number');
  expect(c.age_s!).toBeLessThan(5);        // just refreshed
  expect(c.stale).toBeUndefined();
  const clear = async () => (await fetch(`http://localhost:${port}/worknote/clear`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'CLR' }),
  })).json() as Promise<{ ok: boolean; cleared: boolean }>;
  expect(await clear()).toMatchObject({ ok: true, cleared: true });
  expect(await clear()).toMatchObject({ ok: true, cleared: false });   // nothing left: says so instead of "ok"
});

// #103: the stale mark reached only /worknote/active. /worknote/set's overlaps (the PreToolUse warning) and
// /worknote/repo-active (pre-git) served a dead session's claim as if it were live.
test('/worknote/set overlaps and /worknote/repo-active mark a peer claim that stopped heartbeating as stale', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'cm-wn-stale-'));
  execSync('git init -q', { cwd: repo });
  const root = detectRepoRootSync(repo)!;
  const post = (path: string, body: unknown) => fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const set = async (sid: string) => (await (await post('/worknote/set', { session_id: sid, agent: 'claude', what: 'w', files: [`${root}/a.ts`], ttl_s: 3600 })).json()) as { overlaps: Array<{ session_id: string; stale?: boolean; age_s?: number }> };
  try {
    await set('GHOST');
    setSystemTime(new Date(Date.now() + 15 * 60_000));   // GHOST never refreshes again; its 1 h lease is still live
    const hits = (await set('LIVE')).overlaps.filter((o) => o.session_id === 'GHOST');
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) { expect(h.stale).toBe(true); expect(h.age_s!).toBeGreaterThanOrEqual(15 * 60); }
    const { holders } = (await (await fetch(`http://localhost:${port}/worknote/repo-active?repo_root=${encodeURIComponent(root)}`)).json()) as { holders: Array<{ session_id: string; stale?: boolean }> };
    expect(holders.find((h) => h.session_id === 'GHOST')?.stale).toBe(true);
    expect(holders.find((h) => h.session_id === 'LIVE')!.stale).toBeUndefined();
  } finally {
    setSystemTime();
    for (const sid of ['GHOST', 'LIVE']) await post('/worknote/clear', { session_id: sid });
    rmSync(repo, { recursive: true, force: true });
  }
});
