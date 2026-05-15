import { spawnSync } from 'child_process';
import { MetaStore } from '../../worker/meta.ts';
import { META_DB_PATH } from '../../shared/paths.ts';
import { workerGet, workerPost } from '../client.ts';
import { vacuumCommand } from './vacuum.ts';
import { cyanBold, dim, green, yellow } from '../../shared/ansi.ts';

const SERVICE = 'captain-memo-worker.service';

async function workerIsRunning(): Promise<boolean> {
  try {
    await workerGet('/health');
    return true;
  } catch {
    return false;
  }
}

function systemctlUser(action: 'start' | 'stop' | 'is-enabled'): { ok: boolean; output: string } {
  const r = spawnSync('systemctl', ['--user', action, SERVICE], { encoding: 'utf-8' });
  return { ok: r.status === 0, output: (r.stdout + r.stderr).trim() };
}

async function waitForWorker(timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await workerIsRunning()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

interface UpgradeFlags {
  dryRun: boolean;
  force: boolean;
  skipVacuum: boolean;
}

function parseFlags(args: string[]): UpgradeFlags {
  const flags: UpgradeFlags = { dryRun: false, force: false, skipVacuum: false };
  for (const a of args) {
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--skip-vacuum') flags.skipVacuum = true;
    else if (a === '--help' || a === '-h') {
      console.log(UPGRADE_HELP);
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      console.error(UPGRADE_HELP);
      process.exit(2);
    }
  }
  return flags;
}

const UPGRADE_HELP = `captain-memo upgrade — bring the corpus up to the current chunker shape

Detects pre-v0.1.8 observation chunks, re-chunks them through the live worker,
then stops the worker, runs VACUUM, and restarts. Safe to re-run — the reindex
is resumable and the vacuum is a no-op on an already-compact DB.

Usage:
  captain-memo upgrade [--dry-run] [--force] [--skip-vacuum]

Flags:
  --dry-run       Print what would happen without changing anything
  --force         Re-chunk all observations even if they're already on the new
                  shape (use to apply a future chunker change)
  --skip-vacuum   Skip the VACUUM step (don't take the exclusive lock; useful
                  if you want to keep the worker running through the whole
                  upgrade)`;

export async function upgradeCommand(args: string[]): Promise<number> {
  const flags = parseFlags(args);

  console.log(cyanBold('Captain Memo — upgrade'));
  console.log(dim('───────────────────────'));

  // 1. Detect corpus state.
  const meta = new MetaStore(META_DB_PATH);
  const legacy = meta.countLegacyObservationChunks();
  const stats = meta.stats();
  meta.close();

  console.log(`Corpus state:`);
  console.log(`  total chunks:              ${stats.total_chunks}`);
  console.log(`  legacy observation chunks: ${legacy}`);
  console.log('');

  if (legacy === 0 && !flags.force) {
    console.log(green('Already on the current chunker shape — nothing to reindex.'));
    if (flags.skipVacuum) {
      console.log(dim('(--skip-vacuum: not running VACUUM either)'));
      return 0;
    }
    if (flags.dryRun) {
      console.log(dim('--dry-run: would still run VACUUM to reclaim any prior bloat.'));
      return 0;
    }
    // Even with nothing to reindex, run vacuum so a user re-running upgrade
    // after a deletion still reclaims pages.
    return await runVacuumPhase();
  }

  if (flags.dryRun) {
    if (flags.force) {
      console.log(yellow(`--dry-run + --force: would re-chunk all ${stats.total_chunks} observation chunks.`));
    } else {
      console.log(yellow(`--dry-run: would reindex ${legacy} legacy chunks` +
        (flags.skipVacuum ? '' : ' and run VACUUM') + '.'));
    }
    return 0;
  }

  // 2. Reindex phase — needs a running worker because /reindex lives in HTTP.
  const wasRunning = await workerIsRunning();
  let restartedByUs = false;
  if (!wasRunning) {
    console.log('Starting worker for reindex ...');
    const r = systemctlUser('start');
    if (!r.ok) {
      console.error(`Could not start ${SERVICE}: ${r.output}`);
      console.error('Start it manually, then re-run: captain-memo upgrade');
      return 1;
    }
    restartedByUs = true;
    if (!await waitForWorker()) {
      console.error('Worker did not become reachable within 15 s.');
      return 1;
    }
  }

  console.log(`Re-chunking observations (batched 32/Voyage call; resumable) ...`);
  const reindexResult = await workerPost('/reindex', {
    channel: 'observation',
    force: flags.force,
  }) as { indexed: number; skipped: number; errors: number };
  console.log(
    `  indexed: ${reindexResult.indexed}  ` +
    `skipped: ${reindexResult.skipped}  ` +
    `errors:  ${reindexResult.errors}`,
  );
  if (reindexResult.errors > 0) {
    console.error(yellow(`Reindex finished with ${reindexResult.errors} errors — see worker logs.`));
  }
  console.log('');

  if (flags.skipVacuum) {
    console.log(green('Done (--skip-vacuum). Run `captain-memo vacuum` manually to reclaim disk.'));
    return reindexResult.errors > 0 ? 1 : 0;
  }

  // 3. Vacuum phase — needs an exclusive lock, so stop the worker first.
  console.log('Stopping worker for VACUUM ...');
  const stopR = systemctlUser('stop');
  if (!stopR.ok) {
    console.error(`Could not stop ${SERVICE}: ${stopR.output}`);
    console.error('Stop it manually, then re-run `captain-memo vacuum`.');
    return 1;
  }

  const vacExit = await vacuumCommand([]);
  console.log('');

  // 4. Restart the worker if it was running when we entered, OR if we started
  //    it ourselves (we should leave the system in a useful state by default).
  if (wasRunning || restartedByUs) {
    console.log('Starting worker ...');
    const startR = systemctlUser('start');
    if (!startR.ok) {
      console.error(yellow(`Could not start ${SERVICE}: ${startR.output}`));
      console.error('Start it manually: systemctl --user start captain-memo-worker');
      return 1;
    }
    await waitForWorker();
  }

  console.log(green('Upgrade complete.'));
  return vacExit !== 0 ? vacExit : (reindexResult.errors > 0 ? 1 : 0);
}

async function runVacuumPhase(): Promise<number> {
  const wasRunning = await workerIsRunning();
  if (wasRunning) {
    console.log('Stopping worker for VACUUM ...');
    const r = systemctlUser('stop');
    if (!r.ok) {
      console.error(`Could not stop ${SERVICE}: ${r.output}`);
      return 1;
    }
  }
  const code = await vacuumCommand([]);
  if (wasRunning) {
    console.log('Starting worker ...');
    systemctlUser('start');
    await waitForWorker();
  }
  return code;
}
