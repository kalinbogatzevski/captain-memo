import { VERSION } from '../../shared/version.ts';

export const MANIFEST_FORMAT_VERSION = 1;

export interface EmbedderIdentity {
  provider?: string;
  model: string;
  dimension: number;
  endpoint?: string;
}
export interface BackupFileEntry { path: string; size: number; sha256: string }
export interface BackupCounts { documents: number; chunks: number; observations: number; vectors: number }

export interface BackupManifest {
  format_version: number;
  captain_memo_version: string;
  created_at: string;            // ISO-8601
  platform: string;              // process.platform
  embedder: EmbedderIdentity;
  summarizer: { provider?: string; model?: string };
  includes_secrets: boolean;
  includes_vectors: boolean;
  files: BackupFileEntry[];
  counts: BackupCounts;
}

/** Stream-hash a file's bytes to a hex sha256 (never buffers the whole file). */
export async function fileSha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}

export function buildManifest(
  input: Omit<BackupManifest, 'format_version' | 'captain_memo_version'>,
): BackupManifest {
  return { format_version: MANIFEST_FORMAT_VERSION, captain_memo_version: VERSION, ...input };
}

/** Parse + shape-check an untrusted manifest. Throws Error with an actionable message. */
export function validateManifest(raw: unknown): BackupManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('manifest.json is not an object');
  const m = raw as Record<string, unknown>;
  if (m.format_version !== MANIFEST_FORMAT_VERSION) {
    throw new Error(
      `unsupported backup format version ${String(m.format_version)} (this build reads ${MANIFEST_FORMAT_VERSION})`,
    );
  }
  const emb = m.embedder;
  if (typeof emb !== 'object' || emb === null
      || typeof (emb as Record<string, unknown>).model !== 'string'
      || typeof (emb as Record<string, unknown>).dimension !== 'number') {
    throw new Error('manifest.embedder must carry { model: string, dimension: number }');
  }
  if (!Array.isArray(m.files)) throw new Error('manifest.files must be an array');
  if (typeof m.counts !== 'object' || m.counts === null) throw new Error('manifest.counts missing');
  const counts = m.counts as Record<string, unknown>;
  for (const k of ['documents', 'chunks', 'observations', 'vectors'] as const) {
    if (typeof counts[k] !== 'number') throw new Error(`manifest.counts.${k} must be a number`);
  }
  return m as unknown as BackupManifest;
}

/** Vectors from a backup are reusable only when the target embeds identically. */
export function vectorsCompatible(a: EmbedderIdentity, b: EmbedderIdentity): boolean {
  return a.model === b.model && a.dimension === b.dimension;
}
