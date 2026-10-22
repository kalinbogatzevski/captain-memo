// vibe CaptureSource — Mistral Vibe (2.26+) keeps one folder per session, <root>/unified/<session>/, as plain JSON; vibe-store.ts
// reads it. <root> is `<home>/logs/session` with home = $VIBE_HOME, else ~/.vibe (the same on Linux, macOS and Windows).
// Vibe publishes a new generation and replaces CURRENT last (its source says that happens when a turn ends; not yet watched on a live
// box), so the marker is CURRENT's manifest hash: it changes with every publication, a rewind included. The transcript is rebuilt in
// full each time (no extractFrom: there is no byte offset to resume from), which stays cheap because a sealed chunk is parsed once and
// kept (ChunkCache).
//
// Not captured yet: forks and subagents (a non-null parent_session_id), sessions imported from another tool's history, a custom
// `session_logging.save_dir` from Vibe's config.toml (point CAPTAIN_MEMO_CAPTURE_VIBE_DIR at it), and the older
// <root>/session_*/messages.jsonl layout of Vibe before 2.26.0.

import { existsSync, lstatSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import type { RawObservationEvent } from '../../shared/types.ts';
import type { CaptureSource, SessionRef } from './types.ts';
import { entriesToTurnEvents } from './shared.ts';
import { ChunkCache, KNOWN_MINOR, STORE_FORMAT, readCurrent, readTranscript, sessionSkipReason } from './vibe-store.ts';

const DEFAULT_QUIESCE_MS = 60_000;
// Measured on synthetic stores (Bun 1.4.2, Linux, warm page cache, run niced behind other jobs, so read them as upper bounds):
//   discover(), 500 session dirs: 44 ms median when all are finished, 12.5 ms when all are still live (CURRENT is only stat'ed first).
//   A whole tick over those 500, every one already ingested: 70 ms = 0.12% of the 60 s interval (limit 25%); one session growing: 74 ms.
//   extract() of a 20 MB session (318 chunks of 64 KiB): 200 ms without the chunk cache, 17 ms after one more turn with it (tool output
//   dominating, which is not captured, like a real session); text-heavy worst case 317 ms vs 55 ms. The duty cycle is fine either way
//   (317 ms per 60 s = 0.5%); the cache is for the LOCK-HOLD: extract() is synchronous, and the driver yields between sessions, not inside one.
//   The cache accounts the TEXT the mapped entries carry, not the files read: 20 MB of session is 1.2 MB (tool-heavy) to 6.2 MB (text-heavy)
//   of it, so 16 MiB holds the biggest session seen plus its neighbours. Counting file bytes instead would make a 20 MB session overflow
//   the cache and, read in order every time, miss on every chunk.
//   One-off `capture backfill` over the 500: 5.7 s (11 ms per session, yielding between them).
const CHUNK_CACHE_BYTES = 16 * 1024 * 1024;

export interface VibeSourceOptions {
  projectId: string;
  /** The session root: the folder that contains `unified/`. */
  dir?: string;
  /** Sink for "store newer than tested" (a format name and minor number only) and "a session's CURRENT cannot be read" (its folder
   *  name and the error, never file content). Default console.warn. */
  warn?: (msg: string) => void;
  quiesceMs?: number;
  /** Bytes of mapped chunk text kept between ticks; 0 = no cache. */
  cacheBytes?: number;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

/** Vibe's home: $VIBE_HOME with `~` expanded and made absolute, else ~/.vibe. */
function vibeHome(env: Record<string, string | undefined>): string {
  const h = env.VIBE_HOME;
  if (!h) return join(homedir(), '.vibe');
  return resolve(h === '~' || /^~[/\\]/.test(h) ? join(homedir(), h.slice(1)) : h);
}

export function createVibeSource(opts: VibeSourceOptions): CaptureSource {
  const env = opts.env ?? process.env;
  const root = opts.dir ?? env.CAPTAIN_MEMO_CAPTURE_VIBE_DIR ?? join(vibeHome(env), 'logs', 'session');
  const unified = join(root, 'unified');
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const warned = new Set<string>();
  const quiesceMs = opts.quiesceMs ?? Number(env.CAPTAIN_MEMO_CAPTURE_QUIESCE_MS ?? DEFAULT_QUIESCE_MS);
  const now = opts.now ?? (() => Date.now());
  const cache = new ChunkCache(opts.cacheBytes ?? CHUNK_CACHE_BYTES);

  return {
    id: 'vibe' as CaptureSource['id'],
    available: () => existsSync(unified),
    describe: () => unified,
    enabled: () => (env.CAPTAIN_MEMO_CAPTURE_VIBE ?? '1') !== '0',

    discover(): SessionRef[] {
      let dirs;
      try { dirs = readdirSync(unified, { withFileTypes: true }); } catch { return []; }
      const refs: SessionRef[] = [];
      for (const d of dirs) {
        // A symlink is not a directory here, so it is skipped; dotfiles are Vibe's own index files (.session-index.json).
        if (!d.isDirectory() || d.name.startsWith('.')) continue;
        const path = join(unified, d.name);
        let st;
        try { st = lstatSync(join(path, 'CURRENT')); } catch { continue; } // no CURRENT: nothing published yet
        if (!st.isFile() || now() - st.mtimeMs < quiesceMs) continue;     // stat first: a live session is not even opened
        let marker;
        try { marker = readCurrent(path).manifestSha; } catch (e) {
          // A torn pointer heals by the next tick; one that never does (Vibe changed CURRENT's shape) would otherwise drop the session
          // without a trace. Reported once per session and error; readCurrent's message carries no file content.
          const msg = (e as Error).message;
          const key = `current ${d.name} ${msg}`;
          if (!warned.has(key)) { warned.add(key); warn(`[capture:vibe] session ${d.name}: ${msg}; skipped this tick`); }
          continue;
        }
        refs.push({ sessionId: d.name, path, marker, mtimeEpoch: Math.floor(st.mtimeMs / 1000) });
      }
      return refs;
    },

    extract(ref): RawObservationEvent[] {
      if (sessionSkipReason(ref.path)) return []; // the same answer at every marker, so [] cannot reset a cursor that matters
      const { entries, current } = readTranscript(ref.path, cache);
      const seen = `${current.format}/${current.minor}`;
      if ((current.format !== STORE_FORMAT || (current.minor ?? 1) > KNOWN_MINOR) && !warned.has(seen)) {
        warned.add(seen);
        warn(`[capture:vibe] store ${seen} is not one this reader was tested on (${STORE_FORMAT} minor ${KNOWN_MINOR}); reading it anyway`);
      }
      return entriesToTurnEvents(entries, {
        sessionId: ref.sessionId,
        projectId: opts.projectId,
        originAgent: 'vibe',
        toolName: 'vibe-turn',
        sourceTag: 'capture:vibe',
        fallbackTsEpoch: ref.mtimeEpoch,
      });
    },

    // ponytail: no eventCountAtMarker (the marker is a hash, not a size). After an in-place REWIND the extract is shorter than what was
    // ingested, so the driver re-ingests the whole session (duplicates, no loss); a rewind that regrows past the old count hides the
    // replacement turns until the count passes it. Upgrade: a resume point holding a digest of the entries up to the cursor.
  };
}
