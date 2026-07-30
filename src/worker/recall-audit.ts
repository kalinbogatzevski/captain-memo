import { appendFile, rename, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

/** Resolve the audit log path at call time so that CAPTAIN_MEMO_DATA_DIR
 *  overrides set in tests (or at runtime) are always honoured.
 *  We intentionally do NOT import DATA_DIR from paths.ts here: that constant
 *  is evaluated at module load time, meaning env-var overrides set after
 *  import have no effect — important for testability. */
function recallAuditPath(): string {
  const dataDir = process.env.CAPTAIN_MEMO_DATA_DIR ?? join(homedir(), '.captain-memo');
  return join(dataDir, 'recall-audit.jsonl');
}

export interface RecallAuditHit {
  doc_id: string;
  channel: string;
  score: number;
  snippet: string;       // truncated to 200 chars
  boosts?: {
    identifier?: number; // multiplier that was applied (omit if boost didn't fire)
    branch?: number;     // multiplier that was applied (omit if boost didn't fire)
  };
}

export interface RecallAuditEntry {
  ts: number;            // epoch ms
  session_id: string;
  project_id: string;
  query: string;
  prompt?: string;       // optional — only if hook passed raw prompt
  rank_profile: string;  // active rank profile that served these hits
  hits: RecallAuditHit[];
  /** Tokens the assembled envelope actually put into the model's context.
   *  Present on /inject/context lines; absent on explicit /search/* lines,
   *  which return results to a caller rather than injecting anything.
   *
   *  This number was always computed (envelope.ts) and returned in the HTTP
   *  response, then discarded — so there was no way to say what memory had
   *  contributed to a context window over time. Persisting it is what makes
   *  the cost side of "was this worth injecting" answerable at all: paired
   *  with the existing from_auto / from_search / from_drill counters it gives
   *  tokens-spent against usefulness, instead of one without the other. */
  injected_tokens?: number;
}

/** Bound for the audit log; past it, one generation is kept as `.1` and a fresh file started.
 *  Default-ON without a bound is how you fill a customer's disk — one live host reached 24.7 MB with
 *  nothing to stop it. dream-stats already handles the reset: its accumulator rebuilds when the file
 *  is smaller than its cached offset, which is exactly what rotation produces. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
async function rotateIfOversized(path: string): Promise<void> {
  // One stat() per write. A retrieval happens at most once per prompt, so batching the check bought
  // nothing measurable and made the overshoot unbounded in a short-lived process.
  const max = Number(process.env.CAPTAIN_MEMO_RECALL_AUDIT_MAX_BYTES) || DEFAULT_MAX_BYTES;
  try {
    const { size } = await stat(path);
    if (size < max) return;
    await rename(path, path + '.1');   // replaces any previous .1 — exactly one generation kept
  } catch { /* missing file / racing writer: nothing to rotate */ }
}

/**
 * Append one JSON line to the recall audit log.
 *
 * Default-ON. It was opt-in on privacy grounds, but `dream` reads this log, so default-off shipped a
 * dead feature: the stats page said dream was disabled and gave no hint why. The privacy argument does
 * not survive contact with the filesystem — the log never leaves the machine (never indexed into the
 * corpus, never relayed to a peer or hub; every reader is local), the raw prompts are already in the
 * Claude transcript on the same disk, and the memory snippets are already in observations.db on the
 * same disk. It duplicates what the machine already holds.
 *
 * Opt OUT with CAPTAIN_MEMO_RECALL_AUDIT=0. Bounded by rotation, because a default-on log that grows
 * without limit is a real problem where the privacy one was not.
 *
 * Failure-safe: a write error is logged to stderr but never propagates.
 */
export async function writeRecallAuditLine(entry: RecallAuditEntry): Promise<void> {
  if (process.env.CAPTAIN_MEMO_RECALL_AUDIT === '0') return;

  const path = recallAuditPath();
  const line = JSON.stringify(entry) + '\n';
  try {
    await rotateIfOversized(path);
    await appendFile(path, line, 'utf8');
  } catch (err) {
    console.error('[recall-audit] write failed:', (err as Error).message);
  }
}
