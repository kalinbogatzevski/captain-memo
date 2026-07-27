import { appendFile } from 'fs/promises';
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

/**
 * Append one JSON line to the recall audit log.
 *
 * Default-off: writes only when CAPTAIN_MEMO_RECALL_AUDIT=1 is explicitly set.
 * Privacy-first — opt-in because prompts can contain sensitive content.
 * Failure-safe: a write error is logged to stderr but never propagates.
 */
export async function writeRecallAuditLine(entry: RecallAuditEntry): Promise<void> {
  if (process.env.CAPTAIN_MEMO_RECALL_AUDIT !== '1') return;

  const line = JSON.stringify(entry) + '\n';
  try {
    await appendFile(recallAuditPath(), line, 'utf8');
  } catch (err) {
    console.error('[recall-audit] write failed:', (err as Error).message);
  }
}
