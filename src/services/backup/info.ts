import { readManifestFromArchive } from './snapshot.ts';
import type { BackupManifest } from './manifest.ts';

export async function readBackupInfo(archivePath: string): Promise<BackupManifest> {
  return readManifestFromArchive(archivePath);
}

// Strip C0 (0x00-0x1F), DEL (0x7F), and C1 (0x80-0x9F) control characters from untrusted
// manifest string fields so a crafted archive can't inject ANSI escapes or forge a line.
function sanitize(s: unknown): string {
  return String(s)
    .split('')
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return !(c <= 0x1f || (c >= 0x7f && c <= 0x9f));
    })
    .join('');
}

export function formatBackupInfo(m: BackupManifest): string {
  const e = m.embedder;
  return [
    `Captain Memo backup (format v${m.format_version})`,
    `  created:     ${sanitize(m.created_at)}  on ${sanitize(m.platform)}`,
    `  app version: ${sanitize(m.captain_memo_version)}`,
    `  embedder:    ${sanitize(e.model)}  dim=${e.dimension}${e.endpoint ? `  (${sanitize(e.endpoint)})` : ''}`,
    `  counts:      ${m.counts.documents} docs · ${m.counts.chunks} chunks · ` +
      `${m.counts.observations} observations · ${m.counts.vectors} vectors`,
    `  vectors:     ${m.includes_vectors ? 'included' : 'not included (restore re-embeds)'}`,
    `  secrets:     ${m.includes_secrets ? 'INCLUDED (worker.env — contains API keys)' : 'not included'}`,
  ].join('\n');
}
