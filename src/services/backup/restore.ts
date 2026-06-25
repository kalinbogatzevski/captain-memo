// src/services/backup/restore.ts
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, copyFileSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractArchive, readManifestFromArchive, readVecDimension, countRows, backupStamp,
} from './snapshot.ts';
import { fileSha256, vectorsCompatible, type BackupManifest, type EmbedderIdentity } from './manifest.ts';
import { resolveDataDir, resolveConfigDir } from './create.ts';
import { getServiceManager } from '../service-manager/index.ts';
import { workerPost, workerGetOptional } from '../../cli/client.ts';
import { DEFAULT_WORKER_PORT } from '../../shared/paths.ts';

const WORKER_SERVICE = 'captain-memo-worker';

export class RestoreError extends Error {}

export interface RestoreOptions { force?: boolean; reindex?: boolean; startWorker?: boolean }
export interface RestoreResult {
  restored: BackupManifest;
  vectorsRebuilt: boolean;
  preRestoreDir: string | null;
  counts: { chunks: number; observations: number };
}

const DURABLE_NAMES = ['meta.sqlite3', 'observations.db'];

function targetIsNonEmpty(dataDir: string): boolean {
  return existsSync(join(dataDir, 'meta.sqlite3'))
    || existsSync(join(dataDir, 'observations.db'))
    || existsSync(join(dataDir, 'vector-db', 'embeddings.db'));
}

/** The target install's CURRENT embedder identity (for the vector decision). */
async function targetEmbedder(dataDir: string): Promise<EmbedderIdentity> {
  const stats = (await workerGetOptional('/stats', 800)) as { embedder?: { model?: string } } | null;
  const model = stats?.embedder?.model
    ?? process.env.CAPTAIN_MEMO_EMBEDDER_MODEL ?? 'voyageai/voyage-4-nano';
  const vecDb = join(dataDir, 'vector-db', 'embeddings.db');
  const dimension = (existsSync(vecDb) ? readVecDimension(vecDb) : null)
    ?? (Number(process.env.CAPTAIN_MEMO_EMBEDDING_DIM) || 2048);
  return { model, dimension };
}

export async function restoreBackup(archivePath: string, opts: RestoreOptions = {}): Promise<RestoreResult> {
  const startWorker = opts.startWorker ?? true;
  const dataDir = resolveDataDir();
  const configDir = resolveConfigDir();

  // ── Phase A: validate everything BEFORE touching the target ──
  const tmp = mkdtempSync(join(tmpdir(), 'cm-restore-stage-'));
  try {
    await extractArchive(archivePath, tmp);                     // throws on a non-archive
    const manifest = await readManifestFromArchive(archivePath);
    for (const f of manifest.files) {
      const abs = join(tmp, f.path);
      if (!existsSync(abs)) throw new RestoreError(`archive missing listed file: ${f.path}`);
      if ((await fileSha256(abs)) !== f.sha256) throw new RestoreError(`checksum mismatch: ${f.path}`);
    }

    // Capture target state BEFORE stopping the worker or moving any file.
    const wasNonEmpty = targetIsNonEmpty(dataDir);
    const currentEmbedder = await targetEmbedder(dataDir);

    if (wasNonEmpty && !opts.force) {
      throw new RestoreError(
        'Target already has memories. Re-run with --force to replace them ' +
        '(the existing corpus is moved aside to a recoverable .pre-restore-* dir).',
      );
    }

    // ── Phase B: mutate the target (worker down) ──
    const sm = getServiceManager();
    if (startWorker) { try { await sm.stop(WORKER_SERVICE, { graceful: true, port: DEFAULT_WORKER_PORT }); } catch { /* may be down */ } }

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    // Move current durable files aside (recoverable rollback).
    let preRestoreDir: string | null = null;
    if (wasNonEmpty) {
      preRestoreDir = join(dataDir, `.pre-restore-${backupStamp()}`);
      mkdirSync(preRestoreDir, { recursive: true });
      for (const n of DURABLE_NAMES) moveIfExists(join(dataDir, n), join(preRestoreDir, n));
      if (existsSync(join(dataDir, 'vector-db'))) moveIfExists(join(dataDir, 'vector-db'), join(preRestoreDir, 'vector-db'));
      // Drop stale WAL sidecars of the replaced DBs.
      for (const n of DURABLE_NAMES) for (const s of ['-wal', '-shm']) rmIfExists(join(dataDir, n + s));
    }

    // Copy restored durable DBs into place.
    moveIfExists(join(tmp, 'data', 'meta.sqlite3'), join(dataDir, 'meta.sqlite3'));
    moveIfExists(join(tmp, 'data', 'observations.db'), join(dataDir, 'observations.db'));
    const restoredVec = join(tmp, 'data', 'vector-db', 'embeddings.db');
    const hasVec = existsSync(restoredVec);

    // Apply config + secrets.
    if (existsSync(join(tmp, 'config', 'config.json'))) copyFileSync(join(tmp, 'config', 'config.json'), join(dataDir, 'config.json'));
    if (existsSync(join(tmp, 'config', 'worker.env'))) copyFileSync(join(tmp, 'config', 'worker.env'), join(configDir, 'worker.env'));

    // Vector decision: keep restored vectors only if the target embeds identically.
    let vectorsRebuilt = false;
    const compatible = hasVec && manifest.includes_vectors
      && vectorsCompatible(manifest.embedder, currentEmbedder);
    mkdirSync(join(dataDir, 'vector-db'), { recursive: true });
    if (compatible && !opts.reindex) {
      moveIfExists(restoredVec, join(dataDir, 'vector-db', 'embeddings.db'));
    } else {
      // Drop any stale vectors → they are rebuilt from chunk text + observations.
      rmIfExists(join(dataDir, 'vector-db', 'embeddings.db'));
      vectorsRebuilt = true;
    }

    // ── Phase C: bring the worker back; rebuild vectors if needed ──
    if (startWorker) {
      await sm.start(WORKER_SERVICE);
      if (vectorsRebuilt) {
        try { await workerPost('/reindex', { channel: 'all', force: true }); } catch { /* surfaced by caller */ }
      }
    }

    return {
      restored: manifest,
      vectorsRebuilt,
      preRestoreDir,
      counts: {
        chunks: countRows(join(dataDir, 'meta.sqlite3'), 'SELECT count(*) AS n FROM chunks'),
        observations: countRows(join(dataDir, 'observations.db'), 'SELECT count(*) AS n FROM observations'),
      },
    };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function moveIfExists(from: string, to: string): void {
  if (!existsSync(from)) return;
  mkdirSync(join(to, '..'), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err: unknown) {
    // EXDEV: cross-device link — fall back to copy + unlink
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyAndRemove(from, to);
  }
}

function copyAndRemove(from: string, to: string): void {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      copyAndRemove(join(from, entry), join(to, entry));
    }
  } else {
    copyFileSync(from, to);
  }
  rmSync(from, { recursive: true, force: true });
}

function rmIfExists(p: string): void { if (existsSync(p)) { try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } } }
