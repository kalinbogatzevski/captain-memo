// src/worker/inject-latency.ts — the rolling latency window for /inject/context (spec §4.1,
// docs/superpowers/specs/2026-08-07-hook-retrieval-latency-design.md).
//
// WHY THIS EXISTS: the hook fails OPEN. When /inject/context misses its deadline the turn silently
// loses its memory injection and nothing surfaces — 865 such failures accumulated over ten weeks
// before anyone noticed. A latency record is what turns "it feels slow sometimes" into a number
// doctor can act on.
//
// WHY IT LIVES ON MAIN: /inject/context is a READ (served by a reader thread) while /stats is a
// WRITE (served by the writer) — see route-class.ts. A ring inside an engine would therefore be
// invisible to the endpoint that reports it. Main proxies BOTH, so it is the only place that can
// see every inject and still answer /stats without cross-thread aggregation.
//
// NOT PERSISTED, deliberately. doctor is a live diagnosis and a restart legitimately resets the
// picture; persisting would add a write path to the very thread this design keeps clear.

export interface InjectSample {
  elapsed_ms: number;
  /** null when the call skipped the embed — those are excluded from embed_p50_ms rather than
   *  counted as zero, which would drag the median toward a cost that was never paid. */
  embed_ms: number | null;
  degraded: boolean;
  over_deadline: boolean;
}

export interface InjectLatencyStats {
  n: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  embed_p50_ms: number | null;
  over_deadline_n: number;
  degraded_n: number;
}

/** Spec §4.1: the last 200 outcomes. Big enough that one slow call cannot swing the p50, small
 *  enough that the window still reflects the last few minutes of real use rather than an average
 *  over the whole uptime — a captain that was slow an hour ago and is fine now should read fine. */
export const INJECT_WINDOW = 200;

/** Percentile by nearest-rank on a sorted array. Nearest-rank (not interpolated) because these are
 *  observed request costs, and reporting a p95 that no request actually took invites "where did
 *  that number come from" every time someone checks it against a log. */
function pct(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))]!;
}

export class InjectLatencyRing {
  private readonly buf: InjectSample[] = [];

  constructor(private readonly cap: number = INJECT_WINDOW) {}

  /** Record one outcome. FAILURES COUNT TOO (spec §4.1): a call that ends in thread_rpc_timeout is
   *  recorded, not dropped — otherwise the window measures only the successes and flatters the p50
   *  at exactly the moment things are worst. */
  record(s: InjectSample): void {
    this.buf.push(s);
    if (this.buf.length > this.cap) this.buf.splice(0, this.buf.length - this.cap);
  }

  size(): number { return this.buf.length; }

  stats(): InjectLatencyStats {
    const n = this.buf.length;
    if (n === 0) {
      return { n: 0, p50_ms: 0, p95_ms: 0, max_ms: 0, embed_p50_ms: null, over_deadline_n: 0, degraded_n: 0 };
    }
    const elapsed = this.buf.map((s) => s.elapsed_ms).sort((a, b) => a - b);
    const embeds = this.buf.map((s) => s.embed_ms).filter((v): v is number => v !== null).sort((a, b) => a - b);
    return {
      n,
      p50_ms: pct(elapsed, 50),
      p95_ms: pct(elapsed, 95),
      max_ms: elapsed[elapsed.length - 1]!,
      embed_p50_ms: embeds.length > 0 ? pct(embeds, 50) : null,
      over_deadline_n: this.buf.reduce((acc, s) => acc + (s.over_deadline ? 1 : 0), 0),
      degraded_n: this.buf.reduce((acc, s) => acc + (s.degraded ? 1 : 0), 0),
    };
  }
}
