// Mistral Vibe session-store reader. Pure: it imports nothing from the worker, the driver or federation, so the OSS line
// copies it unchanged.
//
// Layout (read from Vibe 2.26.1 and 3.0.1 source; the key sets confirmed by listings from real stores, store minor 8 and 9):
//   <root>/unified/<session>/CURRENT                      { store_format, store_format_minor, session_id, generation, snapshot_sequence, manifest_sha256 }
//   <root>/unified/<session>/generations/<generation>/manifest.json   { execution_state quiescent|recoverable, projection_state { path, chunks[] }, ... }
//   <root>/unified/<session>/chunks/<sha256>.json         a JSON array of history entries; content-addressed, so a sealed chunk never changes
//   <root>/unified/<session>/meta.json                    { parent_session_id, import_provenance, ... }, written by the app-server after the first turn
// Plain canonical JSON. Vibe publishes CURRENT last and atomically, so a read that starts at CURRENT finds every file it names.
// The manifest's `chunks` is absent on a store written before the chunk pool existed: its entries then sit in the projection envelope.
//
// Captured: user text, committed assistant text, tool name + the first 200 chars of its arguments (` [error]` when it failed).
// Not captured: reasoning, tool output, notices, checkpoints, the system prompt, and every content block that is not plain text
// (an image is base64, a text resource is a whole file body).
//
// Privacy: no error thrown here carries file content; a failure names the file kind and the errno, or "not valid JSON".

import { lstatSync, readFileSync } from 'fs';
import { join } from 'path';
import { clip, type TranscriptEntry } from './shared.ts';

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export const STORE_FORMAT = 'mistral.vibe.unified-session-store/v1';
/** Newest store_format_minor this reader was written against (Vibe 3.0.1). A newer one is still read; the source reports it once. */
export const KNOWN_MINOR = 9;
const ARGS_MAX = 200;
const GENERATION = /^[0-9]{16}$/; // Vibe's own pattern for a generation name
const SHA256 = /^[0-9a-f]{64}$/;

/** createdAt is epoch MILLISECONDS on every store seen (13 digits); a value under 1e12 is taken as seconds (kimi-wire's rule). */
const epoch = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v > 1e12 ? v / 1000 : v) : undefined; // the enqueue schema wants an integer

/** lstat first: Vibe itself refuses a symlink inside its store, so a link planted there is never followed. null = the file is absent
 *  and `optional`; anything else wrong throws a message that names the file kind and the errno only, never content. */
function readJson(path: string, what: string, optional = false): unknown {
  try {
    if (!lstatSync(path).isFile()) throw new Error('not a regular file');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (optional && code === 'ENOENT') return null;
    throw new Error(`vibe ${what}: ${code ?? (e instanceof SyntaxError ? 'not valid JSON' : (e as Error).message)}`);
  }
}

/** One mapped chunk is a pure function of the chunk's bytes, so the cache key is the sha256 in its file name. */
export class ChunkCache {
  private readonly m = new Map<string, { entries: TranscriptEntry[]; cost: number }>();
  private bytes = 0;
  /** `maxBytes` bounds the TEXT held (what the mapped entries carry), not the files read; 0 turns the cache off. */
  constructor(private readonly maxBytes: number) {}

  get(sha: string): TranscriptEntry[] | undefined {
    const hit = this.m.get(sha);
    if (!hit) return undefined;
    this.m.delete(sha); // least recently used goes first
    this.m.set(sha, hit);
    return hit.entries;
  }

  set(sha: string, entries: TranscriptEntry[]): void {
    const cost = 1 + entries.reduce((n, e) => n + e.text.length, 0);
    if (cost > this.maxBytes) return;
    this.m.set(sha, { entries, cost });
    this.bytes += cost;
    for (const [k, v] of this.m) {
      if (this.bytes <= this.maxBytes) break;
      this.m.delete(k);
      this.bytes -= v.cost;
    }
  }
}

export interface VibeCurrent {
  generation: string;
  /** Changes on every publication, a rewind included. */
  manifestSha: string;
  /** null when the pointer has none (Vibe reads that as minor 1). */
  minor: number | null;
  format: string | null;
}

export function readCurrent(sessionDir: string): VibeCurrent {
  const c = readJson(join(sessionDir, 'CURRENT'), 'CURRENT');
  const generation = isObj(c) ? str(c.generation) : undefined;
  const manifestSha = isObj(c) ? str(c.manifest_sha256) : undefined;
  if (!isObj(c) || !generation || !manifestSha || !GENERATION.test(generation) || !SHA256.test(manifestSha)) throw new Error('vibe CURRENT: unexpected shape');
  return { generation, manifestSha, minor: typeof c.store_format_minor === 'number' ? c.store_format_minor : null, format: str(c.store_format) ?? null };
}

/** The history entry as the transcript line it contributes, or null when it contributes nothing. */
function mapEntry(e: unknown): TranscriptEntry | null {
  if (!isObj(e)) return null;
  // A running tool call or a streamed assistant message is provisional: wait for its commit (a later generation holds it completed).
  if (typeof e.generationStatus === 'string' && e.generationStatus !== 'completed') return null;
  const tsEpoch = epoch(e.createdAt);
  if (e.type === 'message') {
    const user = e.role === 'user';
    if (!user && !(e.role === 'assistant' && isObj(e.outcome) && e.outcome.type === 'committed')) return null;
    const text: string[] = [];
    if (Array.isArray(e.content)) for (const b of e.content) if (isObj(b) && b.type === 'text' && typeof b.text === 'string') text.push(b.text);
    return { role: user ? 'user' : 'assistant', text: clip(text.join('\n')), tsEpoch };
  }
  if (e.type === 'effect') {
    const detail = isObj(e.detail) ? e.detail : {};
    // Vibe writes the same string to `title` and `detail.toolName` (_projection.py _effect_detail / _running_effect_entry).
    const name = str(detail.toolName) ?? str(e.title) ?? 'tool';
    const args = detail.input == null ? '' : clip(JSON.stringify(detail.input), ARGS_MAX);
    const failed = isObj(e.state) && e.state.status === 'failed';
    return { role: 'tool', text: `${name}(${args})${failed ? ' [error]' : ''}`, tsEpoch };
  }
  return null;
}

const mapAll = (arr: unknown[]): TranscriptEntry[] => arr.flatMap((e) => mapEntry(e) ?? []);

/** The session's transcript at its CURRENT generation. Throws when it cannot be read RIGHT NOW (torn pointer, a chunk the 2-generation
 *  collector just removed): the driver then retries next tick, whereas returning [] would reset its events_ingested cursor to 0 and the
 *  next good read would enqueue the whole session again. A session with nothing in it yet is a normal [] (no chunks listed). */
export function readTranscript(sessionDir: string, cache: ChunkCache): { entries: TranscriptEntry[]; current: VibeCurrent } {
  const current = readCurrent(sessionDir);
  const genDir = join(sessionDir, 'generations', current.generation);
  const manifest = readJson(join(genDir, 'manifest.json'), 'manifest');
  const ps = isObj(manifest) ? manifest.projection_state : undefined;
  if (!isObj(manifest) || !isObj(ps)) throw new Error('vibe manifest: unexpected shape');

  let entries: TranscriptEntry[] = [];
  if (Array.isArray(ps.chunks)) {
    for (const sha of ps.chunks) {
      if (typeof sha !== 'string' || !SHA256.test(sha)) throw new Error('vibe manifest: bad chunk name'); // also keeps `../` out of join()
      let mapped = cache.get(sha);
      if (!mapped) {
        const arr = readJson(join(sessionDir, 'chunks', `${sha}.json`), `chunk ${sha.slice(0, 8)}`);
        if (!Array.isArray(arr)) throw new Error(`vibe chunk ${sha.slice(0, 8)}: not an array`);
        cache.set(sha, mapped = mapAll(arr));
      }
      for (const m of mapped) entries.push(m);
    }
  } else {
    // A store written before the chunk pool: the entries sit in the projection envelope (StoredFileV1.chunks is absent then).
    const file = str(ps.path);
    if (!file || file === '.' || file === '..' || /[/\\]/.test(file)) throw new Error('vibe manifest: bad projection-state name');
    const env = readJson(join(genDir, file), 'projection-state');
    const inline = isObj(env) && isObj(env.snapshot) && isObj(env.snapshot.history) ? env.snapshot.history.entries : undefined;
    if (!Array.isArray(inline)) throw new Error('vibe projection-state: no history');
    entries = mapAll(inline);
  }

  // The driver slices by event COUNT. A generation that is not quiescent was published with a turn still running (or cut off), and a later
  // generation completes that SAME turn: reading it now would freeze the turn at its first half and the answer would never be enqueued.
  // So hold the last user turn back until a quiescent generation shows it whole. Any value but "quiescent" holds it, a future one too.
  if (manifest.execution_state !== 'quiescent') {
    let i = entries.length - 1;
    while (i >= 0 && entries[i]!.role !== 'user') i--;
    entries = i < 0 ? [] : entries.slice(0, i);
  }
  return { entries, current };
}

/** Why this session is not captured: a fork or a subagent (a non-null parent_session_id; a fork copies its parent's history, so it would be
 *  ingested twice) or an import of another tool's history (that tool's own source already captured it). null = capture it.
 *  A missing meta.json is a session to capture: Vibe writes it right after the first turn starts, best effort, and a failed write only logs.
 *  A meta.json that is present but unreadable throws (retry next tick): treating it as "no fork" could ingest a fork's copied prefix. */
export function sessionSkipReason(sessionDir: string): 'child' | 'import' | null {
  const meta = readJson(join(sessionDir, 'meta.json'), 'meta.json', true);
  if (meta === null) return null;
  if (!isObj(meta)) throw new Error('vibe meta.json: unexpected shape');
  if (meta.parent_session_id != null) return 'child';
  if (meta.import_provenance != null || meta.external_import != null) return 'import';
  return null;
}
