// Guard 2 (2026-09-30): two sessions in one checkout each overwrote the other's uncommitted work while the board only
// warned. /worknote/set with `enforce` now refuses a file a LIVE Claude Code claim (one carrying a pid) of another
// session holds, and the refused file never enters the caller's claim. Stale, pid-less (Codex, Gemini), same-pid,
// dead-pid, already-held, overridden and whole-repo holders do not block. work_set and /worknote/clear act only on the
// caller's own session.
import { test, expect, beforeAll, afterAll, setSystemTime } from 'bun:test';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { detectRepoRootSyncCached, _resetRepoRootCache } from '../../src/worker/branch.ts';

let worker: WorkerHandle;
let port = 0;
const REPO_FILE = join(import.meta.dir, '../../src/worker/index.ts');

beforeAll(async () => {
  worker = await startWorker({
    port: 0, projectId: 'test-project', metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused', embedderModel: 'fake',
    vectorDbPath: ':memory:', embeddingDimension: 8, skipEmbed: true,
  });
  port = worker.port;
  _resetRepoRootCache();
  const deadline = Date.now() + 20_000;
  while (detectRepoRootSyncCached(dirname(REPO_FILE)) === null) {
    if (Date.now() > deadline) throw new Error('git never resolved a repo root');
    _resetRepoRootCache();
    await Bun.sleep(100);
  }
});
afterAll(async () => { setSystemTime(); await worker.stop(); });

type Holder = { session_id: string; agent: string; age_s: number };
type SetR = { overlaps: Array<{ session_id: string; kind?: string; override?: { files: string[] } }>; deny?: { files: string[]; holders: Holder[] }; override?: { files: string[] } };
const post = async <T = SetR>(path: string, body: unknown): Promise<{ status: number; body: T }> => {
  const r = await fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as T };
};
/** A Claude hook edit: files = what it already held + touched (as the hook sends it), enforce on, a live pid unless
 *  the case says otherwise (`pid: undefined` = a Codex or Gemini hook, which sends none). */
const CALLER_PID = 4_000_001;   // only a HOLDER's pid is liveness-checked; this one just differs from process.pid
const edit = async (session_id: string, touched: string[], extra: Record<string, unknown> = {}) =>
  (await post('/worknote/set', { session_id, agent: 'claude', what: 'editing', files: touched, touched, enforce: true, enrich_from_observations: true, pid: CALLER_PID, ...extra })).body;
const claimsOf = async (sid: string) => ((await (await fetch(`http://localhost:${port}/worknote/active?session_id=${sid}`)).json()) as { claims: Array<{ session_id: string; files: string[]; override?: unknown }>; my_override?: { files: string[] } });
const DEAD_PID = spawnSync('true').pid!;

test('1. a live peer holds the file: deny, holder named, and the stored claim does not take it', async () => {
  await edit('A1', ['/w1/hr/functions.php'], { pid: process.pid });
  const r = await edit('B1', ['/w1/hr/functions.php'], { pid: 999_999_1 });
  expect(r.deny?.files).toEqual(['/w1/hr/functions.php']);
  expect(r.deny?.holders[0]).toMatchObject({ session_id: 'A1', agent: 'claude' });
  const b = (await claimsOf('B1')).claims.find((c) => c.session_id === 'B1')!;
  expect(b.files).not.toContain('/w1/hr/functions.php');   // the heartbeat landed, the file did not
  // a refused upload claims none of its files: not the local source, and not the remote target either
  await edit('B1', ['/w1/hr/functions.php', 'root@h:/srv/functions.php']);
  expect((await claimsOf('B1')).claims.find((c) => c.session_id === 'B1')!.files).not.toContain('root@h:/srv/functions.php');
});

test('2. a stale peer: advisory overlap only, no deny', async () => {
  const t0 = Date.now();
  await edit('A2', ['/w2/x.php'], { pid: process.pid });
  setSystemTime(new Date(t0 + 11 * 60_000));
  const r = await edit('B2', ['/w2/x.php']);
  setSystemTime();
  expect(r.deny).toBeUndefined();
  expect(r.overlaps.some((o) => o.session_id === 'A2' && o.kind === 'files')).toBe(true);
});

test('3. the caller already held the file: both hold it, no deny (the deadlock rule)', async () => {
  await edit('B3', ['/w3/x.php']);
  // A3 claims it later via work_set (no enforce), from a live Claude process
  await post('/worknote/set', { session_id: 'A3', agent: 'claude', what: 'mine too', files: ['/w3/x.php'], pid: process.pid });
  const r = await edit('B3', ['/w3/x.php']);
  expect(r.deny).toBeUndefined();
});

test('4. a Codex/Gemini hook (no pid) is never denied, and a pid-less claim (work_set, Codex) never blocks', async () => {
  await edit('A4', ['/w4/x.php'], { pid: process.pid });
  const r = await edit('H4', ['/w4/x.php'], { agent: 'codex', pid: undefined });
  expect(r.deny).toBeUndefined();
  expect(r.overlaps.some((o) => o.session_id === 'A4')).toBe(true);   // still warned
  await post('/worknote/set', { session_id: 'mcp-4', agent: 'codex', what: 'declared', files: ['/w4/y.php'] });
  expect((await edit('B4', ['/w4/y.php'])).deny).toBeUndefined();
});

test('5. same pid, different session id (/clear, resume): no deny', async () => {
  await edit('A5', ['/w5/x.php'], { pid: process.pid });
  expect((await edit('B5', ['/w5/x.php'], { pid: process.pid })).deny).toBeUndefined();
});

test('6. the holder\'s process has exited: no deny', async () => {
  await edit('A6', ['/w6/x.php'], { pid: DEAD_PID });
  expect((await edit('B6', ['/w6/x.php'])).deny).toBeUndefined();
});


test('8. an override covers the file: no deny, the board shows it, and the holder\'s next overlap names it', async () => {
  await edit('A8', ['/w8/x.php'], { pid: process.pid });
  const ov = await post<{ files: string[]; holders: string[]; until: number }>('/worknote/override', { session_id: 'B8', files: ['/w8/x.php'] });
  expect(ov.body.holders).toEqual(['A8']);
  const r = await edit('B8', ['/w8/x.php']);
  expect(r.deny).toBeUndefined();
  expect(r.override?.files).toEqual(['/w8/x.php']);
  const a = await edit('A8', ['/w8/x.php'], { pid: process.pid });
  expect(a.overlaps.find((o) => o.session_id === 'B8')?.override?.files).toEqual(['/w8/x.php']);
  const act = await claimsOf('B8');
  expect(act.my_override?.files).toEqual(['/w8/x.php']);
  expect(act.claims.find((c) => c.session_id === 'B8')?.override).toBeDefined();
});

test('9. a whole-repo peer claim (`**`, `<root>/**`): neither deny nor overlap; a declared directory still overlaps', async () => {
  const root = detectRepoRootSyncCached(dirname(REPO_FILE))!;
  await post('/worknote/set', { session_id: 'W9a', agent: 'claude', what: 'x', files: ['**'] });
  await post('/worknote/set', { session_id: 'W9b', agent: 'claude', what: 'y', files: [`${root}/**`] });
  const r = await edit('B9', [REPO_FILE]);
  expect(r.deny).toBeUndefined();
  expect(r.overlaps.filter((o) => o.kind === 'files' && (o.session_id === 'W9a' || o.session_id === 'W9b'))).toEqual([]);
  await post('/worknote/set', { session_id: 'D9', agent: 'claude', what: 'z', files: [`${dirname(REPO_FILE)}/**`] });
  const r2 = await edit('B9', [REPO_FILE]);
  expect(r2.overlaps.some((o) => o.session_id === 'D9' && o.kind === 'files')).toBe(true);
});

test('enforce off (the kill switch): the same collision only warns', async () => {
  await edit('A10', ['/w10/x.php'], { pid: process.pid });
  const r = (await post('/worknote/set', { session_id: 'B10', agent: 'claude', what: 'e', files: ['/w10/x.php'], touched: ['/w10/x.php'], enforce: false })).body;
  expect(r.deny).toBeUndefined();
  expect(r.overlaps.some((o) => o.session_id === 'A10')).toBe(true);
});

test('/worknote/clear clears only the caller\'s own session, live or stale', async () => {
  await edit('A11', ['/w11/x.php'], { pid: process.pid });
  const refused = await post<{ error?: string; cleared: boolean }>('/worknote/clear', { session_id: 'A11', by: 'B11' });
  expect(refused.status).toBe(403);
  expect(refused.body.error).toBe('not_your_session');
  const t0 = Date.now();
  setSystemTime(new Date(t0 + 11 * 60_000));
  const stale = await post<{ error?: string }>('/worknote/clear', { session_id: 'A11', by: 'B11' });
  setSystemTime();
  expect(stale.body.error).toBe('not_your_session');   // stale is still not the caller's
  await edit('A12', ['/w12/x.php'], { pid: process.pid });
  expect((await post<{ cleared: boolean }>('/worknote/clear', { session_id: 'A12', by: 'A12' })).body.cleared).toBe(true);
  // no `by`: an MCP server from before this change, still serving its open session, clearing its own claim
  await edit('A13', ['/w13/x.php'], { pid: process.pid });
  expect((await post<{ cleared: boolean }>('/worknote/clear', { session_id: 'A13' })).body.cleared).toBe(true);
  // the same Claude process under a new id (after /clear) may clear its old claim
  await edit('A14', ['/w14/x.php'], { pid: 424_242 });
  await edit('A14b', ['/w14/y.php'], { pid: 424_242 });
  expect((await post<{ cleared: boolean }>('/worknote/clear', { session_id: 'A14', by: 'A14b' })).body.cleared).toBe(true);
  // a pid-less claim (a Codex hook claim, whose MCP id differs) can be cleared by another id: nothing pairs them here
  await edit('A16', ['/w16/x.php'], { pid: undefined });
  expect((await post<{ cleared: boolean }>('/worknote/clear', { session_id: 'A16', by: 'mcp-16' })).body.cleared).toBe(true);
});

test('work_set acts only on the caller\'s own session', async () => {
  await edit('A15', ['/w15/x.php'], { pid: process.pid });
  const r = await post<{ error?: string }>('/worknote/set', { session_id: 'A15', by: 'B15', what: 'x', files: ['/w15/y.php'] });
  expect(r.status).toBe(403);
  expect(r.body.error).toBe('not_your_session');
  expect((await post('/worknote/set', { session_id: 'A15', by: 'A15', what: 'x', files: ['/w15/y.php'] })).status).toBe(200);
  // no claim yet under that id: only the caller itself may start one
  expect((await post('/worknote/set', { session_id: 'N15', by: 'B15', what: 'x', files: [] })).status).toBe(403);
});

test('a caller whose OWN claim on the file went stale is denied, twice in a row, once a live peer holds it', async () => {
  const t0 = Date.now();
  await edit('B14', ['/w14/x.php']);
  setSystemTime(new Date(t0 + 11 * 60_000));
  await edit('A14', ['/w14/x.php'], { pid: process.pid });   // A14 edits while B14 is quiet: only warned
  const first = await edit('B14', ['/w14/x.php']);
  const second = await edit('B14', ['/w14/x.php']);
  setSystemTime();
  expect(first.deny?.files).toEqual(['/w14/x.php']);
  expect(second.deny?.files).toEqual(['/w14/x.php']);
});

test('the caller\'s own whole-repo claim (`<root>/**`, e.g. work_set files ".") holds no file: it is still denied', async () => {
  const root = detectRepoRootSyncCached(dirname(REPO_FILE))!;
  const target = join(root, 'CHANGELOG.md');
  await post('/worknote/set', { session_id: 'B15', agent: 'claude', what: 'everything', files: [`${root}/**`] });
  await edit('A15', [target], { pid: process.pid });
  expect((await edit('B15', [target])).deny?.files).toEqual([target]);
});

test('work_set cannot take a file a live session holds, so it cannot unlock the edit guard either', async () => {
  await edit('Aws', ['/wws/hr/functions.php'], { pid: process.pid });
  // the MCP work_set body under Claude Code: a declaration (no enrich hint) with enforce, its files as touched, and a pid
  const r = (await post('/worknote/set', { session_id: 'Bws', agent: 'claude', what: 'hr fix', files: ['/wws/hr/functions.php', '/wws/hr/other.php'], touched: ['/wws/hr/functions.php', '/wws/hr/other.php'], enforce: true, pid: 999_999_7 })).body;
  expect(r.deny?.files).toEqual(['/wws/hr/functions.php']);
  expect((await claimsOf('Bws')).claims.find((c) => c.session_id === 'Bws')!.files).toEqual(['/wws/hr/other.php']);   // only the contested file is left out
  expect((await edit('Bws', ['/wws/hr/functions.php'], { pid: 999_999_7 })).deny?.files).toEqual(['/wws/hr/functions.php']);
});
