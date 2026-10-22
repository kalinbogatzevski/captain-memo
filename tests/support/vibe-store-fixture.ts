// Builds a Mistral Vibe unified session store (<root>/unified/<id>/...) in a temp dir, from the key sets of real 2.26.1 / 3.0.1 stores
// (store_format_minor 8 and 9). Placeholders only: nothing here is a real id, path, hash, name or text. Re-calling it for the same id
// publishes a NEW generation (CURRENT replaced last), leaving the older generation dirs and chunk files on disk as Vibe does.
import { createHash } from 'crypto';
import { mkdirSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';

type Rec = Record<string, unknown>;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const doc = (v: unknown): string => JSON.stringify(v) + '\n'; // Vibe: canonical JSON + one trailing newline
const pad = (n: number): string => String(n).padStart(16, '0');

export const T0 = 1_785_000_000_000; // epoch MILLISECONDS, like every createdAt seen on a real store
export const STORE_FORMAT = 'mistral.vibe.unified-session-store/v1';

let n = 0;
const common = (type: string, ts: number): Rec => ({
  id: `${type}-${++n}`, sessionId: 'placeholder', turnId: 'turn-1', type, createdAt: ts, updatedAt: ts,
  generationStatus: 'completed', relatedEntryId: null, inputEntryId: null,
});

export const userMsg = (text: string, ts = T0, over: Rec = {}): Rec =>
  ({ ...common('message', ts), role: 'user', source: 'turn_start', content: [{ type: 'text', text }], ...over });
export const assistantMsg = (text: string, ts = T0, over: Rec = {}): Rec =>
  ({ ...common('message', ts), role: 'assistant', source: 'harness', outcome: { type: 'committed' }, content: [{ type: 'text', text }], ...over });
export const reasoningEntry = (text: string, ts = T0): Rec =>
  ({ ...common('reasoning', ts), outcome: { type: 'committed' }, summary: [], text });
export const effectEntry = (toolName: string, input: unknown, status = 'completed', outputText = '', ts = T0, over: Rec = {}): Rec => ({
  ...common('effect', ts), title: toolName,
  detail: { display: { summary: toolName }, input, kind: 'tool', toolName },
  state: { status, outputText, output: { content: [{ type: 'text', text: outputText }] } }, ...over,
});

const META: Rec = {
  archived_at: null, bumped_at: null, child_sessions: [], config: { active_model: 'placeholder-model', model_name: 'placeholder-model' },
  created_worktree: null, end_time: null, environment: { working_directory: '/placeholder/project' }, experiments: {},
  git_branch: 'main', git_commit: '0000000', import_provenance: null, loops: [], origin_directory: '/placeholder/project',
  parent_session_id: null, pinned_at: null, seen_at: null, start_time: '2026-01-01T00:00:00Z', title: 'placeholder',
  title_source: 'auto', unseen_at: null, username: 'placeholder-user',
};

export interface FixtureOpts {
  /** Entries per chunk file, in the order the manifest names them. */
  chunks?: unknown[][];
  /** Pre-pool store: the manifest names no chunks and the entries sit in the projection envelope. */
  inline?: unknown[];
  minor?: number;
  /** Generation number (names generations/<16 digits>). */
  generation?: number;
  execution?: string;
  /** Fields merged over the placeholder meta.json; 'none' writes no meta.json, 'torn' writes half of one. */
  meta?: Rec | 'none' | 'torn';
  /** CURRENT mtime in epoch seconds. */
  mtimeSec?: number;
  /** Chunk files of an older generation that stay on disk without being named. */
  staleChunks?: unknown[][];
}

/** Writes the session and returns its folder. */
export function writeVibeSession(root: string, id: string, o: FixtureOpts = {}): string {
  const dir = join(root, 'unified', id);
  const generation = o.generation ?? 1;
  const gen = pad(generation);
  mkdirSync(join(dir, 'chunks'), { recursive: true });
  mkdirSync(join(dir, 'journal'), { recursive: true });
  mkdirSync(join(dir, 'generations', gen), { recursive: true });
  const put = (rel: string, text: string): string => { writeFileSync(join(dir, rel), text); return sha(text); };

  const chunk = (c: unknown[]): string => { const t = doc(c); const h = sha(t); writeFileSync(join(dir, 'chunks', `${h}.json`), t); return h; };
  for (const c of o.staleChunks ?? []) chunk(c);
  const names = (o.chunks ?? []).map(chunk);

  const envelope = doc({
    projection_state_version: 1, session_id: id, snapshot_sequence: generation, watermark: 0,
    snapshot: { activeCallbacks: [], format: 'placeholder', history: { entries: o.inline ?? [] }, latestTurn: null, session: {}, turnQueue: [] },
  });
  const ps = `generations/${gen}/projection-state.json`;
  const projectionSha = put(ps, envelope);
  const checkpointSha = put(`generations/${gen}/checkpoint.json`, doc({}));
  const runtimeSha = put(`generations/${gen}/runtime-state.json`, doc({}));
  writeFileSync(join(dir, 'journal', `${pad(generation + 1)}.jsonl`), ''); // the empty next segment
  const manifestText = doc({
    checkpoint: { path: 'checkpoint.json', sha256: checkpointSha, checkpoint_version: 1 }, created_at: '2026-01-01T00:00:00Z',
    execution_state: o.execution ?? 'quiescent', generation: gen, interop_export: null, manifest_version: 1,
    projection_state: { path: 'projection-state.json', sha256: projectionSha, ...(o.inline ? {} : { chunks: names }) },
    recovery_journal_segment: { path: `journal/${pad(generation + 1)}.jsonl`, first_sequence: generation + 1 },
    runtime_state: { path: 'runtime-state.json', sha256: runtimeSha }, session_id: id, snapshot_sequence: generation,
  });
  const manifestSha = put(`generations/${gen}/manifest.json`, manifestText);

  if (o.meta !== 'none') {
    const text = doc({ ...META, session_id: id, ...(o.meta === 'torn' || o.meta === undefined ? {} : o.meta) });
    writeFileSync(join(dir, 'meta.json'), o.meta === 'torn' ? text.slice(0, 40) : text);
  }
  // CURRENT last, as Vibe publishes it.
  writeFileSync(join(dir, 'CURRENT'), doc({
    generation: gen, manifest_sha256: manifestSha, session_id: id, snapshot_sequence: generation,
    store_format: STORE_FORMAT, store_format_minor: o.minor ?? 9,
  }));
  if (o.mtimeSec !== undefined) utimesSync(join(dir, 'CURRENT'), o.mtimeSec, o.mtimeSec);
  return dir;
}
