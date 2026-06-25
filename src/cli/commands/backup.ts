// src/cli/commands/backup.ts
// `captain-memo backup create|restore|info` — portable memory archive.
import { createBackup } from '../../services/backup/create.ts';
import { restoreBackup, RestoreError } from '../../services/backup/restore.ts';
import { readBackupInfo, formatBackupInfo } from '../../services/backup/info.ts';
import { fmtBytes } from '../../shared/format.ts';

const USAGE = `Usage:
  captain-memo backup create [--out PATH] [--no-vectors]
  captain-memo backup restore <FILE> [--force] [--reindex]
  captain-memo backup info <FILE>`;

export async function backupCommand(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'create':  return backupCreate(rest);
    case 'restore': return backupRestore(rest);
    case 'info':    return backupInfo(rest);
    default:
      console.error(USAGE);
      return 2;
  }
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function backupCreate(args: string[]): Promise<number> {
  const outPath = flagValue(args, '--out');
  const includeVectors = !args.includes('--no-vectors');
  const res = await createBackup({ outPath, includeVectors });
  console.log(`✓ backup written: ${res.outPath}  (${fmtBytes(res.sizeBytes)})`);
  console.log(
    `  ${res.manifest.counts.chunks} chunks · ${res.manifest.counts.observations} observations · ` +
    `${res.manifest.counts.vectors} vectors`,
  );
  if (res.secretsIncluded) {
    console.log('');
    console.log('⚠  This archive CONTAINS API keys (worker.env). Store it securely —');
    console.log('   it is chmod 600, but treat it like a password. Do not commit or share it.');
  } else {
    console.log('');
    console.log('ℹ  worker.env (API keys / secrets) was not found — not included in this archive.');
    console.log('   Re-enter your API keys after restore, or copy worker.env manually.');
  }
  return 0;
}

async function backupRestore(args: string[]): Promise<number> {
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error(USAGE); return 2; }
  const force = args.includes('--force');
  const reindex = args.includes('--reindex');
  try {
    const res = await restoreBackup(file, { force, reindex });
    console.log(`✓ restored: ${res.counts.chunks} chunks · ${res.counts.observations} observations`);
    if (res.vectorsRebuilt) console.log('  vectors rebuilt from source (embedder differed or --reindex) — reindex running');
    else console.log('  vectors restored as-is (embedder matched)');
    if (res.preRestoreDir) console.log(`  previous corpus kept at: ${res.preRestoreDir}`);
    console.log('  note: federation/peer identity is not transferred — re-establish it on this host if needed.');
    return 0;
  } catch (err) {
    if (err instanceof RestoreError) { console.error(`✗ ${err.message}`); return 1; }
    throw err;
  }
}

async function backupInfo(args: string[]): Promise<number> {
  const file = args[0];
  if (!file) { console.error(USAGE); return 2; }
  console.log(formatBackupInfo(await readBackupInfo(file)));
  return 0;
}
