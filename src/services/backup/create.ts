// src/services/backup/create.ts
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, renameSync, chmodSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import {
  durableTargets, hotSnapshot, readVecDimension, readVecCount, createArchive, countRows, backupStamp,
} from './snapshot.ts';
import {
  buildManifest, fileSha256,
  type BackupManifest, type BackupFileEntry, type EmbedderIdentity,
} from './manifest.ts';
import { workerGetOptional } from '../../cli/client.ts';
import { DEFAULT_VOYAGE_ENDPOINT } from '../../shared/paths.ts';

export interface CreateBackupOptions { outPath?: string; includeVectors?: boolean }
export interface CreateBackupResult {
  outPath: string; sizeBytes: number; manifest: BackupManifest; secretsIncluded: boolean;
}

/** Call-time env resolution so tests can redirect DATA_DIR / CONFIG_DIR. */
export function resolveDataDir(): string {
  return process.env.CAPTAIN_MEMO_DATA_DIR ?? join(homedir(), '.captain-memo');
}
export function resolveConfigDir(): string {
  if (process.env.CAPTAIN_MEMO_CONFIG_DIR) return process.env.CAPTAIN_MEMO_CONFIG_DIR;
  return process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'captain-memo')
    : join(homedir(), '.config', 'captain-memo');
}
/** First existing worker.env across CONFIG_DIR, DATA_DIR, then /etc (non-Windows). */
export function effectiveWorkerEnv(): string | null {
  const candidates = [
    join(resolveConfigDir(), 'worker.env'),
    join(resolveDataDir(), 'worker.env'),
  ];
  if (process.platform !== 'win32') candidates.push('/etc/captain-memo/worker.env');
  return candidates.find((p) => existsSync(p)) ?? null;
}

function isoNow(): string { return new Date().toISOString(); }

async function resolveEmbedder(vecDbPath: string, includeVectors: boolean): Promise<EmbedderIdentity> {
  const stats = (await workerGetOptional('/stats', 800)) as
    { embedder?: { model?: string; endpoint?: string } } | null;
  const model = stats?.embedder?.model
    ?? process.env.CAPTAIN_MEMO_EMBEDDER_MODEL ?? 'voyageai/voyage-4-nano';
  const endpoint = stats?.embedder?.endpoint
    ?? process.env.CAPTAIN_MEMO_EMBEDDER_ENDPOINT ?? DEFAULT_VOYAGE_ENDPOINT;
  const dimFromVecs = (includeVectors && existsSync(vecDbPath)) ? readVecDimension(vecDbPath) : null;
  const dimension = dimFromVecs ?? (Number(process.env.CAPTAIN_MEMO_EMBEDDING_DIM) || 2048);
  const provider = process.env.CAPTAIN_MEMO_EMBEDDER_PROVIDER;
  return { ...(provider ? { provider } : {}), model, dimension, endpoint };
}

export async function createBackup(opts: CreateBackupOptions = {}): Promise<CreateBackupResult> {
  const includeVectors = opts.includeVectors ?? true;
  const dataDir = resolveDataDir();
  const outPath = opts.outPath ?? join(process.cwd(), `captain-memo-backup-${backupStamp()}.tar.gz`);
  const partial = outPath + '.partial';

  const staging = mkdtempSync(join(tmpdir(), 'cm-backup-stage-'));
  try {
    mkdirSync(join(staging, 'data', 'vector-db'), { recursive: true });
    mkdirSync(join(staging, 'config'), { recursive: true });

    const files: BackupFileEntry[] = [];
    const addFile = async (rel: string, abs: string) => {
      files.push({ path: rel, size: statSync(abs).size, sha256: await fileSha256(abs) });
    };

    // 1. hot-snapshot the durable DBs (allowlist).
    let vectorsIncluded = false;
    for (const t of durableTargets(dataDir)) {
      if (t.isVector && !includeVectors) continue;
      if (!existsSync(t.srcPath)) continue;
      const dest = join(staging, t.archivePath);
      mkdirSync(join(dest, '..'), { recursive: true });
      hotSnapshot(t.srcPath, dest, { loadVec: t.isVector });
      await addFile(t.archivePath, dest);
      if (t.isVector) vectorsIncluded = true;
    }

    // 2. config.json (if present) + the effective worker.env (secrets).
    const configJson = join(dataDir, 'config.json');
    if (existsSync(configJson)) {
      copyFileSync(configJson, join(staging, 'config', 'config.json'));
      await addFile('config/config.json', join(staging, 'config', 'config.json'));
    }
    const workerEnv = effectiveWorkerEnv();
    let secretsIncluded = false;
    if (workerEnv) {
      copyFileSync(workerEnv, join(staging, 'config', 'worker.env'));
      await addFile('config/worker.env', join(staging, 'config', 'worker.env'));
      secretsIncluded = true;
    }

    // 3. identity + counts (direct from DBs → exact, works worker-down).
    const vecDbPath = join(dataDir, 'vector-db', 'embeddings.db');
    const manifest = buildManifest({
      created_at: isoNow(),
      platform: process.platform,
      embedder: await resolveEmbedder(vecDbPath, includeVectors),
      summarizer: {
        ...(process.env.CAPTAIN_MEMO_SUMMARIZER_PROVIDER ? { provider: process.env.CAPTAIN_MEMO_SUMMARIZER_PROVIDER } : {}),
        ...(process.env.CAPTAIN_MEMO_SUMMARIZER_MODEL ? { model: process.env.CAPTAIN_MEMO_SUMMARIZER_MODEL } : {}),
      },
      includes_secrets: secretsIncluded,
      includes_vectors: vectorsIncluded,
      files,
      counts: {
        documents: countRows(join(dataDir, 'meta.sqlite3'), 'SELECT count(*) AS n FROM documents'),
        chunks: countRows(join(dataDir, 'meta.sqlite3'), 'SELECT count(*) AS n FROM chunks'),
        observations: countRows(join(dataDir, 'observations.db'), 'SELECT count(*) AS n FROM observations'),
        vectors: vectorsIncluded ? readVecCount(vecDbPath) : 0,
      },
    });
    await Bun.write(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // 4. archive → atomic rename → lock down (contains secrets).
    if (existsSync(partial)) rmSync(partial);
    await createArchive(staging, partial);
    renameSync(partial, outPath);
    if (process.platform !== 'win32') chmodSync(outPath, 0o600);

    return { outPath, sizeBytes: statSync(outPath).size, manifest, secretsIncluded };
  } catch (err) {
    if (existsSync(partial)) { try { rmSync(partial); } catch { /* best-effort */ } }
    throw err;
  } finally {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
