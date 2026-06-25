// src/services/backup/snapshot.ts
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { existsSync } from 'fs';
import { join } from 'path';
import { validateManifest, type BackupManifest } from './manifest.ts';

export interface DurableTarget { archivePath: string; srcPath: string; isVector: boolean }

/** The backup ALLOWLIST. Anything not named here (queue.db, pending_embed.db,
 *  logs/, federation.json, *.bak, sockets) is excluded by construction — which is
 *  also what keeps the feature free of any federation coupling. */
export function durableTargets(dataDir: string): DurableTarget[] {
  return [
    { archivePath: 'data/meta.sqlite3',            srcPath: join(dataDir, 'meta.sqlite3'),               isVector: false },
    { archivePath: 'data/observations.db',         srcPath: join(dataDir, 'observations.db'),            isVector: false },
    { archivePath: 'data/vector-db/embeddings.db', srcPath: join(dataDir, 'vector-db', 'embeddings.db'), isVector: true  },
  ];
}

/** SQLite string-literal escaping: double every single quote. */
function sqlLiteral(s: string): string { return `'${s.replace(/'/g, "''")}'`; }

/** Consistent hot copy of a live WAL database into a single dest file via
 *  `VACUUM INTO`. The worker may keep writing; we read the last committed state.
 *  For the vector db the sqlite-vec extension MUST be loaded first, or VACUUM
 *  cannot recreate the vec0 virtual table ("no such module: vec0"). */
export function hotSnapshot(srcPath: string, destPath: string, opts: { loadVec?: boolean } = {}): void {
  const db = new Database(srcPath);
  try {
    if (opts.loadVec) sqliteVec.load(db);
    db.exec(`VACUUM INTO ${sqlLiteral(destPath)}`);
  } finally {
    db.close();
  }
}

/** Authoritative embedding dimension = what the stored vectors actually are,
 *  parsed from the vec_chunks declaration `embedding FLOAT[N]`. null if absent. */
export function readVecDimension(embeddingsDbPath: string): number | null {
  const db = new Database(embeddingsDbPath, { readonly: true });
  try {
    sqliteVec.load(db);
    const row = db.query(
      "SELECT sql FROM sqlite_master WHERE name = 'vec_chunks'",
    ).get() as { sql: string } | undefined;
    if (!row?.sql) return null;
    const m = row.sql.match(/FLOAT\s*\[\s*(\d+)\s*\]/i);
    return m ? Number(m[1]) : null;
  } finally {
    db.close();
  }
}

export function readVecCount(embeddingsDbPath: string): number {
  const db = new Database(embeddingsDbPath, { readonly: true });
  try {
    sqliteVec.load(db);
    return (db.query('SELECT count(*) AS n FROM vec_chunks').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Single-row COUNT(*) helper. Returns 0 when the db file is absent so callers
 *  need not branch on existence. Shared by create + restore (no copy-paste). */
export function countRows(dbPath: string, sql: string): number {
  if (!existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true });
  try { return (db.query(sql).get() as { n: number }).n; } finally { db.close(); }
}

/** YYYYMMDDHHMMSS wall-clock stamp for archive + .pre-restore names. */
export function backupStamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '').slice(0, 14);
}

async function runTar(args: string[]): Promise<void> {
  const proc = Bun.spawn(['tar', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`tar ${args.join(' ')} failed (exit ${code}): ${err.trim()}`);
  }
}

/** gzip-tar the staging dir's CONTENTS (relative members) into outPath. */
export async function createArchive(stagingDir: string, outPath: string): Promise<void> {
  await runTar(['-czf', outPath, '-C', stagingDir, '.']);
}

export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  await runTar(['-xzf', archivePath, '-C', destDir]);
}

/** Stream just manifest.json out of the archive to stdout and validate it. */
export async function readManifestFromArchive(archivePath: string): Promise<BackupManifest> {
  const proc = Bun.spawn(['tar', '-xzOf', archivePath, './manifest.json'], { stdout: 'pipe', stderr: 'pipe' });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0 || !text.trim()) {
    // Some tars store the member without the leading "./" — retry that spelling.
    const p2 = Bun.spawn(['tar', '-xzOf', archivePath, 'manifest.json'], { stdout: 'pipe', stderr: 'pipe' });
    const t2 = await new Response(p2.stdout).text();
    if ((await p2.exited) !== 0 || !t2.trim()) throw new Error('archive has no readable manifest.json');
    return validateManifest(JSON.parse(t2));
  }
  return validateManifest(JSON.parse(text));
}
