import type { IngestPipeline } from './ingest.ts';
import type { SummarizerTransport } from './summarizer.ts';

export interface RememberInput {
  body: string;
  type: string;
  name?: string;
  description?: string;
  slug?: string;
  projectContext: { cwd?: string };
  sourceObservationId?: number;
  targetDirOverride?: string;
}

export interface MemoryHit {
  source_path: string;
  score: number;
  chunk_id: string;
}

export interface WriteMemoryDeps {
  ingest: IngestPipeline;
  embed: (texts: string[]) => Promise<number[][]>;
  searchMemory: (queryEmbedding: number[], dir: string, k: number) => Promise<MemoryHit[]>;
  generate: SummarizerTransport;
  registerSelfWrite: (absPath: string) => void;
  rememberDir: string;
  dedupThreshold: number;
}

export type WriteMemoryResult =
  | { ok: true; path: string; action: 'created' | 'updated'; doc_id: string }
  | { ok: false; reason: string };

export interface Frontmatter {
  name: string;
  description: string;
  slug: string;
  type: string;
}

const NAME_MAX = 120;
const DESC_MAX = 280;

// type -> filename prefix. Matches the existing feedback_/reference_ convention;
// introduces decision_. Unknown types use the type itself as prefix.
const PREFIX_MAP: Record<string, string> = {
  feedback: 'feedback',
  preference: 'feedback',
  reference: 'reference',
  decision: 'decision',
};

export function prefixForType(type: string): string {
  return PREFIX_MAP[type] ?? type;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Render the `---` frontmatter block + body the memory chunker parses. */
export function renderFrontmatter(
  fm: Pick<Frontmatter, 'name' | 'description' | 'type'>,
  body: string,
  extra?: { originSessionId?: string; sourceObservationId?: number },
): string {
  const lines = ['---', `name: ${fm.name}`, `description: ${fm.description}`, `type: ${fm.type}`];
  if (extra?.originSessionId) lines.push(`originSessionId: ${extra.originSessionId}`);
  if (extra?.sourceObservationId !== undefined) lines.push(`sourceObservationId: ${extra.sourceObservationId}`);
  lines.push('---');
  return `${lines.join('\n')}\n${body.replace(/^\n+/, '')}`;
}

/** Spec §5 fallback: never block a write on the LLM. */
export function deterministicFrontmatter(body: string, type: string): Frontmatter {
  const firstLine = (body.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? type).slice(0, NAME_MAX);
  const name = firstLine.length > 0 ? firstLine : type;
  const description = body.trim().replace(/\s+/g, ' ').slice(0, DESC_MAX);
  return { name, description, slug: slugify(name) || slugify(type), type };
}
