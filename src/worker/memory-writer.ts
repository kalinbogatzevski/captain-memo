import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';
import { z } from 'zod';
import { projectSlugFromCwd } from '../shared/paths.ts';
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
  | {
      ok: true; path: string; action: 'created' | 'updated'; doc_id: string;
      /** An existing memory this one closely resembles. REPORTED, never acted on — the write went
       *  ahead as asked. Present only when nothing was folded (a collision fold IS the answer). */
      near_duplicate?: { path: string; doc_id: string; score: number };
    }
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

const FrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  slug: z.string().min(1),
  type: z.string().min(1),
});

const FILL_SYSTEM =
  `You distill a curated memory entry's metadata. Given the entry TYPE and BODY,
return ONLY a JSON object: {"name","description","slug","type"}. name = short title;
description = one line; slug = lowercase-dashed filename stem (no prefix, no extension);
type = echo the given type.`;

export function resolveTargetDir(input: RememberInput, rememberDir: string): string {
  if (input.targetDirOverride) return input.targetDirOverride;
  const cwd = input.projectContext.cwd;
  if (cwd) return join(homedir(), '.claude', 'projects', projectSlugFromCwd(cwd), 'memory');
  return rememberDir;
}

/** Fill missing frontmatter via the LLM transport; never throw — fall back deterministically. */
export async function fillFrontmatter(input: RememberInput, generate: SummarizerTransport): Promise<Frontmatter> {
  const complete = input.name && input.description && input.slug;
  if (complete) {
    return { name: input.name!, description: input.description!, slug: input.slug!, type: input.type };
  }
  try {
    const res = await generate({
      model: '', // transport resolves its own model chain
      system: FILL_SYSTEM,
      user: `TYPE: ${input.type}\nBODY:\n${input.body}`,
      max_tokens: 400,
    });
    const text = res.content.find(c => c.type === 'text')?.text ?? '';
    const match = /\{[\s\S]*\}/.exec(text);
    const json = JSON.parse(match ? match[0] : text);
    const parsed = FrontmatterSchema.parse({ ...json, type: json.type ?? input.type });
    return {
      name: input.name ?? parsed.name,
      description: input.description ?? parsed.description,
      slug: input.slug ?? parsed.slug,
      type: input.type,
    };
  } catch {
    const fb = deterministicFrontmatter(input.body, input.type);
    return {
      name: input.name ?? fb.name,
      description: input.description ?? fb.description,
      slug: input.slug ?? fb.slug,
      type: input.type,
    };
  }
}

const MERGE_SYSTEM =
  `You update a curated memory entry. Given the EXISTING entry body and NEW
information, return the merged body that PRESERVES the existing content and folds
in the new information without duplication. Return ONLY the merged body text, no
frontmatter, no commentary.`;

/** Fold new info into an existing body via the LLM; on failure, append the new body. */
async function mergeBody(existingBody: string, newBody: string, generate: SummarizerTransport): Promise<string> {
  try {
    const res = await generate({
      model: '',
      system: MERGE_SYSTEM,
      user: `EXISTING:\n${existingBody}\n\nNEW:\n${newBody}`,
      max_tokens: 1200,
    });
    const text = res.content.find(c => c.type === 'text')?.text?.trim();
    if (text) return text;
  } catch (err) {
    console.warn(`[remember] merge generate failed, appending: ${(err as Error).message}`);
  }
  return `${existingBody.trim()}\n\n${newBody.trim()}`;
}

const SEMANTIC_K = 3;

type DedupDeps = Pick<WriteMemoryDeps, 'embed' | 'searchMemory' | 'dedupThreshold'>;

/**
 * Decide the update target, or null to create. (a) filename collision first
 * (cheap, no embedder), then (b) semantic similarity scoped to `dir`. Embedder
 * failure degrades gracefully to "no semantic match" (spec §5).
 */
export function findCollisionTarget(dir: string, filename: string): string | null {
  const collision = join(dir, filename);
  return existsSync(collision) ? collision : null;
}

/** ADVISORY ONLY — the nearest existing memory at or above the report threshold. It is REPORTED to
 *  the caller and never folded into.
 *
 *  This used to auto-fold, and MEASUREMENT killed that. Across the live 812-memory corpus, the
 *  cosine to the nearest OTHER memory tops out at 0.9554 (p99 0.9326, p95 0.8983, p50 0.7909) while
 *  the gate sat at cos 0.98875 — so against TODAY'S corpus the semantic fold would fire zero times.
 *  Note the limit of that claim: a fold destroys its own evidence (merged pairs no longer exist as
 *  pairs), so this distribution cannot distinguish "never fired" from "fired and consumed everything
 *  above the gate". What it does establish is that nothing currently in the corpus can reach it.
 *  Every benchmark that "proved" it worked used identical bodies, the one input that clears it.
 *
 *  Real duplicates DO exist and sit at 0.93-0.96 — `aj_table_gen_param_binding_bug` vs
 *  `aj_table_gen_bound_params_fatal` (0.9554), `bump-deploy-version` vs `bump_erp_version` (0.9479),
 *  `no_fa4_icons` vs `use_fa6_icons` (0.9389) — every one of them slipped through. But simply
 *  lowering the number would have switched on, for the first time ever, an LLM rewrite of an
 *  existing memory with no backup, no ledger and no undo (see writeMemory's update branch). The
 *  project's OTHER auto-merge, Quartermaster, ships disabled by default, reversible via --undo, with
 *  a merge_events ledger. This one had none of the three and was on by default.
 *
 *  So: report, never rewrite. The caller gets `near_duplicate` and decides. A fold now happens only
 *  on an explicit filename collision, where the caller named the slug and the intent is unambiguous.
 */
export async function findNearDuplicate(
  body: string,
  dir: string,
  deps: DedupDeps,
): Promise<{ path: string; score: number } | null> {
  let embedding: number[];
  try {
    const [vec] = await deps.embed([body]);
    if (!vec) return null;
    embedding = vec;
  } catch (err) {
    console.warn(`[remember] embedder unavailable, skipping near-duplicate check: ${(err as Error).message}`);
    return null;
  }

  const hits = await deps.searchMemory(embedding, dir, SEMANTIC_K);
  const top = hits[0];
  if (top && top.score >= deps.dedupThreshold && top.source_path.startsWith(dir)) {
    return { path: top.source_path, score: top.score };
  }
  return null;
}

export async function writeMemory(input: RememberInput, deps: WriteMemoryDeps): Promise<WriteMemoryResult> {
  if (!input.body || !input.body.trim()) return { ok: false, reason: 'body is required' };
  if (!input.type || !input.type.trim()) return { ok: false, reason: 'type is required' };

  const targetDir = resolveTargetDir(input, deps.rememberDir);
  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `mkdir failed: ${(err as Error).message}` };
  }

  const fm = await fillFrontmatter(input, deps.generate);

  const prefix = prefixForType(fm.type);
  const filename = `${prefix}_${fm.slug}.md`;
  // A fold happens ONLY on an explicit filename collision — the caller named this slug. Semantic
  // similarity is advisory now (see findNearDuplicate): it is reported, never acted on.
  const updateTarget = findCollisionTarget(targetDir, filename);
  const nearDuplicate = updateTarget ? null : await findNearDuplicate(input.body, targetDir, deps);
  const path = updateTarget ?? join(targetDir, filename);
  const action: 'created' | 'updated' = updateTarget ? 'updated' : 'created';

  let body = input.body;
  if (updateTarget) {
    const existingRaw = readFileSync(updateTarget, 'utf-8').replace(/\r\n/g, '\n');
    const fmEnd = existingRaw.indexOf('\n---\n');
    const existingBody = existingRaw.startsWith('---\n') && fmEnd !== -1
      ? existingRaw.slice(fmEnd + 5)
      : existingRaw;
    body = await mergeBody(existingBody, input.body, deps.generate);
  }

  const doc = renderFrontmatter(
    { name: fm.name, description: fm.description, type: fm.type },
    body,
    input.sourceObservationId !== undefined ? { sourceObservationId: input.sourceObservationId } : undefined,
  );

  // Atomic write: temp file in the SAME dir, then rename — the watcher never
  // sees a half-written file.
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, doc, 'utf-8');
    renameSync(tmpPath, path);
  } catch (err) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    return { ok: false, reason: `write failed: ${(err as Error).message}` };
  }

  deps.registerSelfWrite(path);
  try {
    await deps.ingest.indexFile(path, 'memory');
  } catch (err) {
    return { ok: false, reason: `index failed: ${(err as Error).message}` };
  }

  return {
    ok: true, path, action, doc_id: `memory:${basename(path, '.md')}`,
    ...(nearDuplicate && {
      near_duplicate: {
        path: nearDuplicate.path,
        doc_id: `memory:${basename(nearDuplicate.path, '.md')}`,
        score: nearDuplicate.score,
      },
    }),
  };
}
