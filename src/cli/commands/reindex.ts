import { rmSync } from 'fs';
import { join } from 'path';
import { workerPost } from '../client.ts';
import { DEFAULT_WORKER_PORT, VECTOR_DB_DIR } from '../../shared/paths.ts';
import { setWorkerEnvVar } from '../../shared/worker-env.ts';
import { getServiceManager } from '../../services/service-manager/index.ts';
import { probeHealthOnce } from '../../shared/worker-health-probe.ts';
import type { ServiceManager } from '../../services/service-manager/types.ts';

const WORKER_SERVICE = 'captain-memo-worker';

interface ReindexResult { indexed: number; skipped: number; errors: number }

export async function reindexCommand(args: string[]): Promise<number> {
  let channel: 'memory' | 'skill' | 'observation' | 'all' = 'all';
  let force = false;
  let redim: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--channel') {
      const next = args[++i];
      if (!next || !['memory', 'skill', 'observation', 'all'].includes(next)) {
        console.error(`Invalid --channel value: ${next ?? '(missing)'}`);
        return 2;
      }
      channel = next as typeof channel;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--redim') {
      const next = args[++i];
      const n = Number(next);
      if (!next || !Number.isInteger(n) || n <= 0) {
        console.error(`--redim needs a positive integer dimension (e.g. --redim 1024), got: ${next ?? '(missing)'}`);
        return 2;
      }
      redim = n;
    } else {
      console.error(`Unknown reindex flag: ${arg}`);
      return 2;
    }
  }

  // --redim rebuilds the whole index at a new embedding dimension — a stop/edit/drop/
  // start/reindex orchestration, not the in-worker HTTP reindex. It ignores --channel
  // (the dimension change touches every channel) and always force-rebuilds.
  if (redim !== undefined) return redimReindex(redim);

  const result = await workerPost('/reindex', { channel, force }) as ReindexResult;
  console.log('Reindex complete:');
  console.log(`  indexed: ${result.indexed}`);
  console.log(`  skipped: ${result.skipped}`);
  console.log(`  errors:  ${result.errors}`);
  return result.errors > 0 ? 1 : 0;
}

export interface RedimDeps {
  sm?: ServiceManager;
  port?: number;
  probe?: (port: number, timeoutMs?: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  setEnv?: (key: string, value: string) => void;
  rmVectorDb?: () => void;
  reindexAll?: () => Promise<ReindexResult>;
  log?: (msg: string) => void;
}

/** Delete the derived vector index so it recreates at the new dimension on next boot.
 *  ONLY embeddings.db (+ its WAL/SHM) — never observations.db/queue.db (the source). */
function defaultRmVectorDb(): void {
  const base = join(VECTOR_DB_DIR, 'embeddings.db');
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(base + suffix, { force: true }); } catch { /* best-effort */ }
  }
}

/**
 * `captain-memo reindex --redim <n>` — rebuild the vector index at a new embedding
 * dimension. The index is a DERIVED cache (re-embeddable from observations.db + watched
 * files), so dropping it loses no source data. Sequence: stop worker (release the db) →
 * persist CAPTAIN_MEMO_EMBEDDING_DIM=<n> → drop embeddings.db → start worker (recreates
 * the vec table at <n>) → eager reindex from source. Setting the env var alone is NOT
 * enough — an existing vec0 table is locked to its original dimension.
 */
export async function redimReindex(dim: number, deps: RedimDeps = {}): Promise<number> {
  if (!Number.isInteger(dim) || dim <= 0) {
    console.error(`redim: dimension must be a positive integer, got ${dim}`);
    return 2;
  }
  const port = deps.port ?? Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
  const sm = deps.sm ?? getServiceManager();
  const probe = deps.probe ?? probeHealthOnce;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const setEnv = deps.setEnv ?? setWorkerEnvVar;
  const rmVectorDb = deps.rmVectorDb ?? defaultRmVectorDb;
  const reindexAll = deps.reindexAll ?? (() => workerPost('/reindex', { channel: 'all', force: true }) as Promise<ReindexResult>);
  const log = deps.log ?? ((m: string) => console.log(m));

  log(`Rebuilding the vector index at ${dim} dimensions.`);
  log(`The index is a derived cache — it is re-embedded from observations.db and watched files; no source data is deleted.`);

  log('• stopping worker…');
  await sm.stop(WORKER_SERVICE, { graceful: true, port, force: true });

  log(`• setting CAPTAIN_MEMO_EMBEDDING_DIM=${dim} in worker.env`);
  setEnv('CAPTAIN_MEMO_EMBEDDING_DIM', String(dim));

  log('• removing the old vector index (embeddings.db)…');
  rmVectorDb();

  log('• starting worker…');
  await sm.start(WORKER_SERVICE);

  const deadline = now() + 15000;
  let healthy = false;
  while (now() < deadline) {
    if (await probe(port, 1500)) { healthy = true; break; }
    await sleep(500);
  }
  if (!healthy) {
    console.error('worker did not report healthy within 15s after restart — check `captain-memo doctor`. The index will rebuild lazily on next search.');
    return 1;
  }

  log('• re-embedding all content at the new dimension…');
  const r = await reindexAll();
  log(`Reindex complete: indexed ${r.indexed}, skipped ${r.skipped}, errors ${r.errors}.`);
  log(`Done — writes (remember) and vector search now use ${dim}-dim embeddings.`);
  return r.errors > 0 ? 1 : 0;
}
