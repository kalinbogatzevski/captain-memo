import { readManifestFromArchive } from './snapshot.ts';
import type { BackupManifest } from './manifest.ts';

export async function readBackupInfo(archivePath: string): Promise<BackupManifest> {
  return readManifestFromArchive(archivePath);
}

export function formatBackupInfo(m: BackupManifest): string {
  const e = m.embedder;
  return [
    `Captain Memo backup (format v${m.format_version})`,
    `  created:     ${m.created_at}  on ${m.platform}`,
    `  app version: ${m.captain_memo_version}`,
    `  embedder:    ${e.model}  dim=${e.dimension}${e.endpoint ? `  (${e.endpoint})` : ''}`,
    `  counts:      ${m.counts.documents} docs · ${m.counts.chunks} chunks · ` +
      `${m.counts.observations} observations · ${m.counts.vectors} vectors`,
    `  vectors:     ${m.includes_vectors ? 'included' : 'not included (restore re-embeds)'}`,
    `  secrets:     ${m.includes_secrets ? 'INCLUDED (worker.env — contains API keys)' : 'not included'}`,
  ].join('\n');
}
