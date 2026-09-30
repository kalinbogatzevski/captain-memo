// src/worker/dream-stats.ts
//
// Cheap precursor stats for the DREAM section of `captain-memo stats`.
//
// Computes file-level and pair-level diagnostics for the recall audit log
// WITHOUT running clustering. Those diagnostics are the leading indicator
// of when `captain-memo dream --dry-run` will produce meaningful output:
//   - audit log size + entry count + last entry → "is the audit alive?"
//   - co-retrieval pair count + doc coverage   → "is the signal dense yet?"
//
// The digest is INCREMENTAL: a per-process accumulator holds the running result
// plus the byte offset already processed, so each /stats hit reads only the bytes
// appended since — O(new bytes), not O(file) — and stays always-fresh. A fresh
// worker rebuilds from byte 0 on first hit; a shrunk/rotated file resets it.
//
// Why doc-level coverage (not observation-level): for the observation
// channel every observation has exactly one chunk, so doc_id count and
// observation_id count are identical in the dimension we care about — and
// counting docs avoids the meta-DB join that observation-id mapping would
// require. Same number, cheaper path.

import { stat, open } from 'fs/promises';

export interface DreamStats {
  audit_log: {
    path: string;
    /** File size in bytes. 0 if file is missing (audit was never enabled). */
    bytes: number;
    /** Total non-empty JSON lines in the audit log. */
    entries: number;
    /** Epoch ms of the most recent audit entry; null if file is empty/missing. */
    last_entry_epoch_ms: number | null;
  };
  co_retrieval: {
    /** Distinct (doc_a, doc_b) pairs that have ever co-occurred. */
    pairs: number;
    /** Distinct doc_ids that participated in at least one pair (i.e. were
     *  surfaced alongside at least one other doc). */
    docs_covered: number;
  };
  /** What auto-injection has actually put into context windows.
   *
   *  `since_epoch_ms` is derived from the data — the timestamp of the FIRST
   *  entry carrying injected_tokens — rather than configured. The field only
   *  began being written in 0.27.23, so every older line is silently absent
   *  from these totals; publishing the start date alongside them is what keeps
   *  "1.2 M tokens" from being read as an all-time figure it is not. It also
   *  needs no migration and no hardcoded date to go stale. */
  injected: {
    /** Sum of injected_tokens across every entry that carries it. */
    tokens: number;
    /** Entries carrying the field — the denominator for a per-injection mean. */
    injections: number;
    /** Epoch ms of the earliest measured injection; null until the first one. */
    since_epoch_ms: number | null;
  };
}

interface AuditEntry {
  ts?: number;
  hits?: Array<{ doc_id?: string }>;
  injected_tokens?: number;
}

// INCREMENTAL digest state, per audit-log path. The audit log is APPEND-ONLY and
// written on EVERY recall, so re-reading + re-digesting the WHOLE (multi-MB) file
// on each /stats call was the chronic /stats-latency cause. Instead we keep the
// running digest (entry count, last ts, the co-retrieval pair/doc Sets) plus the
// byte OFFSET already processed, and on each call read ONLY the bytes appended
// since — O(new bytes), not O(file). This is both fast AND always fresh (no TTL
// staleness). A per-process accumulator; a fresh worker rebuilds on first hit.
interface Accumulator {
  offset: number;              // bytes fully processed (always at a newline boundary)
  entries: number;
  lastTs: number | null;
  pairs: Set<string>;
  docsCovered: Set<string>;
  injectedTokens: number;
  injections: number;
  injectedSinceTs: number | null;   // ts of the FIRST measured injection seen
}

const ACC = new Map<string, Accumulator>();

function freshAccumulator(): Accumulator {
  return {
    offset: 0, entries: 0, lastTs: null, pairs: new Set(), docsCovered: new Set(),
    injectedTokens: 0, injections: 0, injectedSinceTs: null,
  };
}

/** Digest the COMPLETE lines in `chunk` into `acc`, returning the number of BYTES
 *  consumed (up to the last newline). A trailing partial line — a write in flight —
 *  is left unconsumed so it is re-read (now complete) on the next call. */
async function digestInto(chunk: string, acc: Accumulator): Promise<number> {
  const lastNl = chunk.lastIndexOf('\n');
  if (lastNl < 0) return 0;                       // no complete line yet
  const complete = chunk.slice(0, lastNl + 1);
  let turnStart = performance.now();
  const breathe = async (): Promise<void> => {
    if (performance.now() - turnStart < DIGEST_TURN_MS) return;
    await new Promise<void>(r => setImmediate(r));
    turnStart = performance.now();
  };
  for (const rawLine of complete.split('\n')) {
    await breathe();
    if (!rawLine.trim()) continue;
    acc.entries++;
    let entry: AuditEntry;
    try {
      entry = JSON.parse(rawLine) as AuditEntry;
    } catch {
      continue;  // Corrupt line — skip but still counted in entries.
    }
    if (typeof entry.ts === 'number') acc.lastTs = entry.ts;
    // Injection cost. Guarded on the field's PRESENCE, not truthiness: a genuine
    // 0-token injection (all hits filtered) is a real event and must still count
    // toward the denominator. Search-path lines omit the field entirely and are
    // correctly skipped — nothing entered a context window there.
    if (typeof entry.injected_tokens === 'number' && Number.isFinite(entry.injected_tokens)) {
      acc.injectedTokens += entry.injected_tokens;
      acc.injections++;
      if (acc.injectedSinceTs === null && typeof entry.ts === 'number') {
        acc.injectedSinceTs = entry.ts;   // append-only log ⇒ first seen IS the earliest
      }
    }
    const hits = entry.hits ?? [];
    if (hits.length < 2) continue;
    const docs = Array.from(new Set(
      hits.map(h => h.doc_id).filter((d): d is string => typeof d === 'string'),
    ));
    if (docs.length < 2) continue;
    // Canonical pair keys: sort the two doc_ids so direction doesn't matter.
    for (let i = 0; i < docs.length; i++) {
      for (let j = i + 1; j < docs.length; j++) {
        const a = docs[i]!, b = docs[j]!;
        acc.pairs.add(a < b ? `${a}|${b}` : `${b}|${a}`);
        acc.docsCovered.add(a);
        acc.docsCovered.add(b);
      }
      await breathe();
    }
  }
  return Buffer.byteLength(complete, 'utf8');       // byte length of the consumed prefix
}

/**
 * Read and digest the audit log, returning summary stats. Idempotent and
 * read-only. Failures (file missing, parse errors mid-file) degrade
 * gracefully — they yield zeros, never throw.
 */
export function getDreamStats(auditLogPath: string): Promise<DreamStats> {
  // Single-flight: the digest below yields between slices, so an overlapping call must join it, not re-read.
  let flight = INFLIGHT.get(auditLogPath);
  if (!flight) {
    flight = computeDreamStats(auditLogPath).finally(() => INFLIGHT.delete(auditLogPath));
    INFLIGHT.set(auditLogPath, flight);
  }
  return flight;
}

const INFLIGHT = new Map<string, Promise<DreamStats>>();
// CPU budget per event-loop turn while digesting. One pass over the 8.2 MB dev audit log held the writer 4.2 s at
// boot (the pre-warm; measured 2026-09-30), 1.3 s of it on ONE line: a 1001-hit recall is 500k pairs. So the
// budget is checked per line AND inside the pair loop.
const DIGEST_TURN_MS = 25;

async function computeDreamStats(auditLogPath: string): Promise<DreamStats> {
  let curSize = 0;
  try {
    curSize = (await stat(auditLogPath)).size;
  } catch {
    // File missing (audit never enabled) or unreadable → drop any stale accumulator.
    ACC.delete(auditLogPath);
    return {
      audit_log: { path: auditLogPath, bytes: 0, entries: 0, last_entry_epoch_ms: null },
      co_retrieval: { pairs: 0, docs_covered: 0 },
      injected: { tokens: 0, injections: 0, since_epoch_ms: null },
    };
  }

  let acc = ACC.get(auditLogPath);
  // No prior state, OR the file SHRANK (truncated / rotated) → the offset is no
  // longer valid; start the digest over from byte 0.
  if (!acc || curSize < acc.offset) {
    acc = freshAccumulator();
    ACC.set(auditLogPath, acc);
  }

  // Read and digest ONLY the bytes appended since we last processed this file.
  if (curSize > acc.offset) {
    const fh = await open(auditLogPath, 'r').catch(() => null);
    if (fh) {
      try {
        // Capture the read position BEFORE the awaits, and re-check it after. Read bare, this
        // is the same offset-across-await race fixed in native-session-usage — but WORSE here,
        // because that path dedupes per message id and this one does not, so an overlapping
        // read digests the same lines a second time. Measured against the live 24.5 MB audit
        // log: two overlapping calls returned exactly 2.00x the entries and tokens of one.
        // The boot pre-warm and the ~10s corpus poll on /stats/lite genuinely overlap — that
        // endpoint has no single-flight guard.
        const from = acc.offset;
        const length = curSize - from;
        const buf = Buffer.allocUnsafe(length);
        const { bytesRead } = await fh.read(buf, 0, length, from);
        // Decode [offset, curSize): both ends sit at a newline boundary (the writer
        // appends whole lines), so no multi-byte char is split at the read edges.
        const chunk = buf.toString('utf8', 0, bytesRead);
        // Another scan digested this range while we were awaiting: discard, do not re-digest.
        // Advancing (or digesting) here would double the counts AND leave the offset past what
        // was consumed, which never self-heals once the file grows beyond it.
        if (acc.offset === from) {
          acc.offset = from + await digestInto(chunk, acc);   // advance only past complete lines
        }
      } finally {
        await fh.close();
      }
    }
  }

  return {
    audit_log: { path: auditLogPath, bytes: curSize, entries: acc.entries, last_entry_epoch_ms: acc.lastTs },
    co_retrieval: { pairs: acc.pairs.size, docs_covered: acc.docsCovered.size },
    injected: {
      tokens: acc.injectedTokens,
      injections: acc.injections,
      since_epoch_ms: acc.injectedSinceTs,
    },
  };
}

/** Test-only: clears the per-process cache. Used by unit tests that
 *  exercise consecutive computations against a mutated audit log. */
export function _resetDreamStatsCache(): void {
  ACC.clear();
}
