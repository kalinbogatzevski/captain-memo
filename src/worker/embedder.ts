import { countTokens } from '../shared/tokens.ts';
import { redactSecrets } from '../shared/redact-secrets.ts';

export type ApiFormat = 'openai' | 'aelita';

/** True when the endpoint is on this machine (localhost, [::1], 127.x): the sidecar, a local Ollama. Nothing leaves the
 *  machine and nothing is billed. An endpoint that does not parse is not provably local and counts as hosted. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return host === 'localhost' || host === '[::1]' || /^127\./.test(host);
  } catch {
    return false;
  }
}

/** CAPTAIN_MEMO_EMBED_REDACT=1 (exactly `1`) redacts what is handed to the embedder, when the endpoint is not on this
 *  machine: the text that leaves is redacted, the stored chunk, the FTS index and local search keep the original. A
 *  loopback endpoint (the sidecar, a local Ollama) sends nothing out, so it is left alone. */
export function embedRedactEnabled(endpoint: string, env: Record<string, string | undefined> = process.env): boolean {
  return env.CAPTAIN_MEMO_EMBED_REDACT === '1' && !isLoopbackEndpoint(endpoint);
}

/**
 * Multiplier applied to the nominal model limit when validating locally.
 * gpt-tokenizer (cl100k_base) and Voyage's SentencePiece-derived tokenizer
 * disagree by up to ~15% on code-heavy / multi-byte content. We assume
 * the worst case (true count = local count × 1.15) and reject earlier
 * to ensure we never undercount and slip an oversized input past Voyage.
 */
const TOKEN_COUNT_SAFETY_FACTOR = 0.85;

/**
 * Thrown by Embedder.embed() when an input exceeds the configured
 * maxInputTokens (with safety margin applied). The embedder does not
 * split inputs — splitting would break the 1:1 chunk→embedding mapping
 * callers depend on. Upstream (chunkers, ingest) is responsible for
 * keeping chunks below the limit; this error surfaces violations loudly
 * instead of letting Voyage silently tail-truncate.
 */
export class EmbedderInputTooLarge extends Error {
  readonly tokensEstimated: number;
  readonly tokensLimit: number;
  readonly inputIndex: number;
  constructor(estimated: number, limit: number, index: number) {
    super(
      `Embedder input #${index} too large: ~${estimated} tokens estimated, limit ${limit}. ` +
      `Split the input upstream — embedder does not split (would break chunk→embedding mapping).`,
    );
    this.name = 'EmbedderInputTooLarge';
    this.tokensEstimated = estimated;
    this.tokensLimit = limit;
    this.inputIndex = index;
  }
}

/** Timeout for a request somebody is waiting on: a search query, the boot probe. */
export const INTERACTIVE_TIMEOUT_MS = 1500;

/** Timeout for background indexing batches (ingest, the retry queue). 1.5 s was not enough for them: measured
 *  2026-10-08 against hosted voyage-4-lite from one machine, one call took 1,665 ms for 128 typical chunks
 *  (21k tokens) and 1,336 ms for the 25 biggest chunks (61k tokens), so a healthy provider could be aborted and
 *  the batch sent again. 15 s is about 9x the worst call seen. Override: CAPTAIN_MEMO_EMBEDDER_TIMEOUT_MS. */
export const PATIENT_TIMEOUT_MS = 15_000;

/** Tokens sent in requests that never got an answer (our own timeout, a 5xx, no response), per rolling hour,
 *  before embedding pauses. A healthy provider wastes none: 0 of 180k tokens in the 10 calls measured
 *  2026-10-08. The incident that needed this (one captain, 2026-10-08) spent 7.29M tokens in 108 requests,
 *  about 67k per request, so 500k stops it after ~8 requests. 0 turns the pause off.
 *  Override: CAPTAIN_MEMO_EMBEDDER_WASTE_LIMIT_TOKENS. */
export const WASTE_LIMIT_TOKENS = 500_000;
export const WASTE_WINDOW_MS = 3_600_000;
/** How long embedding stays paused. Afterwards one request is let through: if it is answered the pause is
 *  over, if it is wasted too the pause starts again. */
export const PAUSE_MS = 1_800_000;

/** Thrown by Embedder.embed() without sending anything while embedding is paused for wasted tokens. */
export class EmbedderPaused extends Error {
  readonly untilMs: number;
  constructor(untilMs: number, wastedTokens: number) {
    super(
      `Embedder paused until ${new Date(untilMs).toISOString()}: ${wastedTokens} tokens went to requests that ` +
      `never got an answer in the last hour. A slow link may need CAPTAIN_MEMO_EMBEDDER_TIMEOUT_MS raised.`,
    );
    this.name = 'EmbedderPaused';
    this.untilMs = untilMs;
  }
}

/** The sources somebody is waiting on: a search or recall query, the near-duplicate check of a `remember`, a work-board
 *  claim. By source NAME, not by the `patient` flag. Everything else (ingest, pending-retry, the boot probe, reindex)
 *  is background work with its own protection (the waste pause, the retry queue's backoff) and stays out of the budget. */
export const INTERACTIVE_SOURCES: readonly string[] = ['query', 'remember', 'worknote'];

/** Interactive tokens one Embedder may send in the last hour before it refuses more of them, answered or not. Same
 *  order as WASTE_LIMIT_TOKENS, and for the same reason: the waste pause never sees a successful call, so a client
 *  looping on long queries spent without limit. Measured 2026-10-22 (runaway-measure, #960): 18,000-char queries cost
 *  3,502 tokens each, one client sends ~2.6 a second, so one engine reaches 500k in about 55 s; the live dev machine's
 *  busiest minute of query traffic in a 37-minute sample was 898 tokens (x 60 = 54k an hour), the busiest real session
 *  28 calls a minute of <= 143-character queries. 500k is ~10x the observed query peak, so normal use never meets it.
 *  PER ENGINE: the writer and each search reader count their own, so the worker as a whole can send up to
 *  (1 + reader pool size) x this in an hour. 0 turns the budget off. Override:
 *  CAPTAIN_MEMO_EMBEDDER_INTERACTIVE_BUDGET_TOKENS. The default is for a hosted endpoint: a loopback endpoint (the
 *  sidecar, a local Ollama) bills nothing, so unless the owner sets a number the budget is off there (metering stays on). */
export const INTERACTIVE_BUDGET_TOKENS = 500_000;

/** Minutes of per-minute history an Embedder keeps. It is also the budget's "hour": the last RING_MINUTES minute
 *  slots, this one included, so between 59 and 60 minutes of spend. The ring lives in memory and starts empty at every
 *  restart; nothing is written to disk. */
export const RING_MINUTES = 60;

/** Minutes of that history usage() carries, which is all a reader ever posts to main. Measured 2026-10-22 on this box
 *  (bun 1.4.2, load ~7, this class fed the same traffic; a reader tick is usage() plus the JSON.stringify that compares
 *  it, a post is a structuredClone): the snapshot before the tail was 213-332 B, usage() 6-10 us, stringify 2 us,
 *  clone 12-16 us. With a 6-minute tail it is 861 B (one source busy in all six minutes) to 1.7 KB (all four columns
 *  busy), usage() 15-22 us, stringify 6-10 us, clone 47-76 us: at most ~30 us per 5 s tick (0.0006 % of a core) and
 *  one ~76 us post. A 60-minute tail, measured on a synthetic snapshot of that shape, is 11.7 KB, 94 us stringify,
 *  488 us clone, and twelve times the entries in the `stats` tool's JSON, which an AI reads. Per request, meter() is
 *  0.6 us for an interactive source and 0.14 us for the rest, the guard before the send 0.27 / 0.10 us; the ring is
 *  2,160 B of typed arrays (~3.1 KB heap per Embedder, 0.5 KB before). */
export const TAIL_MINUTES = 6;

/** Thrown by Embedder.embed() without sending anything while an interactive source is over its hour's budget. */
export class EmbedderBudgetExceeded extends Error {
  readonly untilMs: number;
  constructor(untilMs: number, usedTokens: number, limitTokens: number) {
    super(
      `Interactive embed budget used up: ${usedTokens} of ${limitTokens} tokens went to searches and recalls in the last ` +
      `hour; they are refused until ${new Date(untilMs).toISOString()} (they fall back to keyword search). ` +
      `CAPTAIN_MEMO_EMBEDDER_INTERACTIVE_BUDGET_TOKENS raises it, 0 turns it off.`,
    );
    this.name = 'EmbedderBudgetExceeded';
    this.untilMs = untilMs;
  }
}

/** True for the abort our own timeout causes. */
export const isTimeoutError = (e: Error): boolean => e.name === 'AbortError' || /aborted/i.test(e.message);

/** What the embedder has sent since this instance started. Tokens are counted with the local tokenizer, so the
 *  provider's own figure differs a little. */
export interface EmbedUsage {
  since_epoch: number;
  /** HTTP requests sent, every attempt counted. */
  calls: number;
  /** Tokens in those requests. */
  tokens: number;
  /** Tokens in requests that got no answer or a 5xx: possibly billed, never stored. */
  wasted_tokens: number;
  /** Requests our own timeout cut off. */
  aborted: number;
  /** The wasted tokens inside the rolling hour, which is what the pause watches. */
  window_wasted_tokens: number;
  waste_limit_tokens: number;
  paused_until_epoch: number | null;
  by_source: Record<string, { calls: number; tokens: number }>;
  /** The interactive budget (see INTERACTIVE_BUDGET_TOKENS). Absent from a worker older than the budget. */
  interactive_budget?: InteractiveBudgetUsage;
  /** The last TAIL_MINUTES minutes in which anything was sent, oldest first. */
  per_minute?: MinuteUsage[];
  /** The minute with the most interactive tokens since this instance started: the figure to size the budget from. */
  busiest_interactive_minute?: BusiestMinute | null;
}

/** One minute of requests, by source: query, remember and worknote each, every other source summed as 'other'.
 *  Sources that sent nothing that minute are absent. `at_epoch` is the start of the minute, in seconds. */
export interface MinuteUsage {
  at_epoch: number;
  by_source: Record<string, { calls: number; tokens: number }>;
}

export interface BusiestMinute { at_epoch: number; calls: number; tokens: number }

export interface InteractiveBudgetUsage {
  /** Per engine; 0 = off. */
  limit_tokens: number;
  /** Interactive tokens sent in the last hour. In a merged figure: the sum over the engines. */
  window_tokens: number;
  /** While tripped: when interactive embeds are accepted again (in a merged figure: the latest of the engines). */
  paused_until_epoch: number | null;
  /** Times it tripped since start (summed over the engines in a merged figure). */
  trips: number;
  /** Present when limit_tokens is 0 because the endpoint is a loopback one and the owner set no number (not when the
   *  owner set 0). stats and doctor say so instead of just "off". */
  off_reason?: 'local-endpoint';
  /** Present when no pause is running but the last hour's spend is already at the limit (in a merged figure: in at
   *  least one engine): the pause is over, and the next interactive request trips it again and is refused. Per engine,
   *  because window_tokens of a merged figure adds the engines up and the limit is each one's own. */
  over_limit?: true;
}

/**
 * The whole worker's embedder spend, as one EmbedUsage: this engine's own figures plus those of the reader
 * engines, which each run an Embedder of their own and embed every search/inject query. Pure; `readers` are the
 * latest snapshot of each live reader, none of the inputs is changed.
 *
 *  - calls, tokens, wasted_tokens, aborted, window_wasted_tokens and by_source add up. A reader that restarted
 *    starts again from 0, so the total can step down; each reader's slot is simply its newest snapshot.
 *  - since_epoch is the oldest start, paused_until_epoch the latest pause still running at `nowEpoch` (an
 *    expired one reads null, as it does on a single Embedder), waste_limit_tokens the base engine's.
 *  - `readers` is how many snapshots were added in, not how many readers exist: one that has sent nothing yet
 *    (no query so far) has nothing to add.
 *
 *  - interactive_budget adds up window_tokens and trips and takes the latest pause still running; per_minute adds up
 *    the same minute across engines (a minute older than TAIL_MINUTES at `nowEpoch` is dropped: a reader that has
 *    gone quiet keeps its last snapshot); busiest_interactive_minute is the busiest of the engines' own, so it is the
 *    busiest minute of ONE engine, a lower bound on the worker's. None of the three is invented when no input has it.
 *
 * The waste PAUSE stays per engine: each Embedder pauses on its own hour of wasted tokens against its own limit,
 * and a paused reader does not pause the writer's ingest or the other readers. So window_wasted_tokens here can
 * add up past waste_limit_tokens without any one engine having paused, and paused_until_epoch means "at least one
 * engine is paused", not "nothing is being embedded".
 */
export function mergeEmbedUsage(
  base: EmbedUsage,
  readers: readonly EmbedUsage[],
  nowEpoch: number = Math.floor(Date.now() / 1000),
): EmbedUsage & { readers: number } {
  const by_source: EmbedUsage['by_source'] = {};
  const out = { ...base, by_source, paused_until_epoch: null as number | null, readers: readers.length };
  const addShared = (u: EmbedUsage): void => {
    if (u.paused_until_epoch !== null && u.paused_until_epoch > nowEpoch) {
      out.paused_until_epoch = Math.max(out.paused_until_epoch ?? 0, u.paused_until_epoch);
    }
    for (const [k, v] of Object.entries(u.by_source)) {
      const s = (by_source[k] ??= { calls: 0, tokens: 0 });
      s.calls += v.calls;
      s.tokens += v.tokens;
    }
  };
  addShared(base);
  mergeMetering(out, [base, ...readers], nowEpoch);
  for (const u of readers) {
    out.calls += u.calls;
    out.tokens += u.tokens;
    out.wasted_tokens += u.wasted_tokens;
    out.aborted += u.aborted;
    out.window_wasted_tokens += u.window_wasted_tokens;
    out.since_epoch = Math.min(out.since_epoch, u.since_epoch);
    addShared(u);
  }
  return out;
}

/** The metering and budget part of mergeEmbedUsage. `out` starts as a copy of the base, so the three fields are taken
 *  out of it first and set again only when some input carries them. */
function mergeMetering(out: EmbedUsage, all: readonly EmbedUsage[], nowEpoch: number): void {
  delete out.interactive_budget;
  delete out.per_minute;
  delete out.busiest_interactive_minute;
  const budgets = all.flatMap(u => u.interactive_budget ? [u.interactive_budget] : []);
  if (budgets.length > 0) {
    let until: number | null = null;
    for (const b of budgets) {
      if (b.paused_until_epoch !== null && b.paused_until_epoch > nowEpoch) until = Math.max(until ?? 0, b.paused_until_epoch);
    }
    const first = all[0]!.interactive_budget ?? budgets[0]!;   // every engine of a worker has the same limit and endpoint
    out.interactive_budget = {
      limit_tokens: first.limit_tokens,
      window_tokens: budgets.reduce((n, b) => n + b.window_tokens, 0),
      paused_until_epoch: until,
      trips: budgets.reduce((n, b) => n + b.trips, 0),
      ...(first.off_reason && { off_reason: first.off_reason }),
      ...(budgets.some(b => b.over_limit) && { over_limit: true as const }),
    };
  }
  if (all.some(u => u.per_minute)) {
    const oldest = Math.floor(nowEpoch / 60) * 60 - (TAIL_MINUTES - 1) * 60;
    const minutes = new Map<number, MinuteUsage['by_source']>();
    for (const u of all) {
      for (const m of u.per_minute ?? []) {
        if (m.at_epoch < oldest) continue;
        const into = minutes.get(m.at_epoch) ?? {};
        for (const [k, v] of Object.entries(m.by_source)) {
          const s = (into[k] ??= { calls: 0, tokens: 0 });
          s.calls += v.calls;
          s.tokens += v.tokens;
        }
        minutes.set(m.at_epoch, into);
      }
    }
    out.per_minute = [...minutes].sort((a, b) => a[0] - b[0]).map(([at_epoch, by_source]) => ({ at_epoch, by_source }));
  }
  if (all.some(u => u.busiest_interactive_minute !== undefined)) {
    let best: BusiestMinute | null = null;
    for (const u of all) {
      const b = u.busiest_interactive_minute;
      if (b && (!best || b.tokens > best.tokens)) best = b;
    }
    out.busiest_interactive_minute = best ? { ...best } : null;
  }
}

/**
 * Tells `post` the snapshot from `getUsage` whenever it differs from the last one posted, and never before the
 * first request has been sent. Call `tick()` on a timer: a quiet embedder costs one usage() and one comparison
 * and posts nothing. The whole snapshot is compared, so a pause expiring or the waste window running down is
 * noticed as well as new requests. Used by a reader engine to report to the thread that owns /stats.
 */
export function makeUsageReporter(getUsage: () => EmbedUsage, post: (u: EmbedUsage) => void): { tick: () => void } {
  let last = '';
  return {
    tick() {
      const u = getUsage();
      if (u.calls === 0) return;
      const sig = JSON.stringify(u);
      if (sig === last) return;
      last = sig;
      post(u);
    },
  };
}

/** Per-call options. `patient` is for background work nobody waits on. */
export interface EmbedCallOptions {
  source?: string;
  patient?: boolean;
}

export interface EmbedderOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  /** Interactive timeout (default INTERACTIVE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Timeout for `patient` calls (default PATIENT_TIMEOUT_MS). */
  patientTimeoutMs?: number;
  /** See WASTE_LIMIT_TOKENS; 0 turns the pause off. */
  wasteLimitTokens?: number;
  wasteWindowMs?: number;
  pauseMs?: number;
  /** See INTERACTIVE_BUDGET_TOKENS; 0 turns the budget off, and unset it is off for a loopback endpoint and on for the
   *  rest. A number set here applies to any endpoint. The pause when it trips is `pauseMs`, as for the waste. */
  interactiveBudgetTokens?: number;
  maxBatchSize?: number;
  maxRetries?: number;
  // 'openai' (default): POST /v1/embeddings — { input, model, input_type } →
  //   { data: [{ embedding, index }] }; auth via `Authorization: Bearer …`.
  // 'aelita':           POST /embed       — { texts, input_type }           →
  //   { embeddings: [[…], …] };           auth via `x-aelita-token: …`.
  apiFormat?: ApiFormat;
  /**
   * Nominal max input tokens for the configured model. When set, embed()
   * validates each input locally (with safety margin) and throws
   * EmbedderInputTooLarge for overflows BEFORE making the API call. Use
   * embedderMaxTokens(model) from shared/embedder-limits to populate.
   * Leaving this undefined disables local validation (legacy behavior).
   */
  maxInputTokens?: number;
  /** Redact credential-shaped values from every input before it is counted or sent. Unset: embedRedactEnabled(endpoint),
   *  i.e. CAPTAIN_MEMO_EMBED_REDACT=1 and a non-loopback endpoint. */
  redactInput?: boolean;
}

/**
 * Whether the input is being embedded as a search query (we want a vector
 * close to relevant *documents*) or as a document (we want a vector close
 * to relevant *queries*). Voyage and other retrieval-tuned embedders apply
 * different prefixes per type — using the wrong one tanks similarity.
 *
 * Compatibility: OpenAI / Cohere / many local servers ignore this hint
 * silently. Captain Memo's own sidecar honors it. Default: 'document'.
 */
export type InputType = 'query' | 'document';

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
}

interface AelitaResponse {
  embeddings: number[][];
}

/** Throw unless every vector has a finite, non-zero component. A zero vector has no direction: stored, it
 *  sits at cos 0.5 from every query (538 of them pulled one IVF cluster's centroid toward the origin, and
 *  79% of that cluster was zeros). Callers treat the throw like any embed failure and retry later. */
export function assertUsableEmbeddings(vectors: number[][]): number[][] {
  vectors.forEach((v, i) => {
    if (!v.every(Number.isFinite) || !v.some(x => x !== 0)) {
      throw new Error(`embedder returned an unusable vector (all zeros or non-finite) for input ${i}`);
    }
  });
  return vectors;
}

/** The ring's columns: the interactive sources one each, every other source together as the last. */
const COLUMNS: readonly string[] = [...INTERACTIVE_SOURCES, 'other'];
const columnOf = (source: string): number => {
  const i = INTERACTIVE_SOURCES.indexOf(source);
  return i < 0 ? COLUMNS.length - 1 : i;
};
const isInteractive = (source: string): boolean => INTERACTIVE_SOURCES.includes(source);

export class Embedder {
  private endpoint: string;
  private model: string;
  private apiKey: string | undefined;
  private timeoutMs: number;
  private patientTimeoutMs: number;
  private maxBatchSize: number;
  private maxRetries: number;
  private apiFormat: ApiFormat;
  private maxInputTokens: number | undefined;
  private wasteLimit: number;
  private wasteWindowMs: number;
  private pauseMs: number;
  private budgetLimit: number;
  private budgetOffReason: InteractiveBudgetUsage['off_reason'];
  /** True when embed() redacts its inputs (see embedRedactEnabled). */
  readonly redactsInput: boolean;

  private sinceEpoch = Math.floor(Date.now() / 1000);
  private calls = 0;
  private tokens = 0;
  private wastedTokens = 0;
  private aborted = 0;
  private bySource: Record<string, { calls: number; tokens: number }> = {};
  private wasteWindow: Array<{ at: number; tokens: number }> = [];
  private pausedUntil = 0;
  /** Per-minute metering, one slot per minute modulo RING_MINUTES. `ringMinute` is the absolute minute (epoch ms / 60000)
   *  a slot holds, -1 for none, so a slot from an hour ago is recognised and reused rather than summed. 60 slots x 4
   *  columns: 2,160 B; counters are Uint32 (a minute would need 4.3 billion tokens to wrap). */
  private ringMinute = new Int32Array(RING_MINUTES).fill(-1);
  private ringCalls = new Uint32Array(RING_MINUTES * COLUMNS.length);
  private ringTokens = new Uint32Array(RING_MINUTES * COLUMNS.length);
  private busiest: BusiestMinute | null = null;
  /** The interactive budget's own pause, apart from `pausedUntil`: the waste pause stops EVERY source (the retry queue
   *  reads it), this one stops only the interactive ones. */
  private budgetUntil = 0;
  private budgetTrips = 0;

  constructor(opts: EmbedderOptions) {
    this.endpoint = opts.endpoint;
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? INTERACTIVE_TIMEOUT_MS;
    this.patientTimeoutMs = opts.patientTimeoutMs ?? PATIENT_TIMEOUT_MS;
    this.maxBatchSize = opts.maxBatchSize ?? 128;
    this.maxRetries = opts.maxRetries ?? 3;
    this.apiFormat = opts.apiFormat ?? 'openai';
    this.maxInputTokens = opts.maxInputTokens;
    this.wasteLimit = opts.wasteLimitTokens ?? WASTE_LIMIT_TOKENS;
    this.wasteWindowMs = opts.wasteWindowMs ?? WASTE_WINDOW_MS;
    this.pauseMs = opts.pauseMs ?? PAUSE_MS;
    // A loopback endpoint bills nothing, so unless the owner set a number the budget is off there; the ring still counts.
    const loopback = isLoopbackEndpoint(opts.endpoint);
    this.budgetLimit = opts.interactiveBudgetTokens ?? (loopback ? 0 : INTERACTIVE_BUDGET_TOKENS);
    if (opts.interactiveBudgetTokens === undefined && loopback) this.budgetOffReason = 'local-endpoint';
    this.redactsInput = opts.redactInput ?? embedRedactEnabled(opts.endpoint);
  }

  /** When embedding resumes (epoch ms), or 0 when it is not paused. */
  pausedUntilMs(): number {
    return Date.now() < this.pausedUntil ? this.pausedUntil : 0;
  }

  /** When interactive embeds are accepted again (epoch ms), or 0 when the budget has not tripped. */
  budgetPausedUntilMs(): number {
    return Date.now() < this.budgetUntil ? this.budgetUntil : 0;
  }

  /** What a search served by this engine should tell its caller: one entry for each pause that is holding embedding
   *  back right now, [] when none is. A search swallows an embed error and answers from keywords alone, so without
   *  this the caller cannot tell a thin answer from a degraded one. State at the time of asking, so the response that
   *  used up the budget carries it too. Per engine, like the pauses themselves. */
  degradationFlags(): string[] {
    const flags: string[] = [];
    const waste = this.pausedUntilMs();
    if (waste) flags.push(`embedder=paused:wasted-tokens:until=${new Date(waste).toISOString()}`);
    const budget = this.budgetPausedUntilMs();
    if (budget) flags.push(`embedder=paused:interactive-token-budget:until=${new Date(budget).toISOString()}`);
    return flags;
  }

  usage(): EmbedUsage {
    const now = Date.now();
    this.pruneWaste(now);
    const paused = this.pausedUntilMs();
    const budgetPaused = this.budgetPausedUntilMs();
    const used = this.interactiveWindowTokens(now);
    return {
      since_epoch: this.sinceEpoch,
      calls: this.calls,
      tokens: this.tokens,
      wasted_tokens: this.wastedTokens,
      aborted: this.aborted,
      window_wasted_tokens: this.windowTokens(),
      waste_limit_tokens: this.wasteLimit,
      paused_until_epoch: paused ? Math.floor(paused / 1000) : null,
      by_source: structuredClone(this.bySource),
      interactive_budget: {
        limit_tokens: this.budgetLimit,
        window_tokens: used,
        paused_until_epoch: budgetPaused ? Math.floor(budgetPaused / 1000) : null,
        trips: this.budgetTrips,
        ...(this.budgetOffReason && { off_reason: this.budgetOffReason }),
        // The condition assertWithinBudget() trips on: the pause is over and the hour still holds the spend.
        ...(this.budgetLimit > 0 && now >= this.budgetUntil && used >= this.budgetLimit && { over_limit: true as const }),
      },
      per_minute: this.tail(now),
      busiest_interactive_minute: this.busiest ? { ...this.busiest } : null,
    };
  }

  async embed(texts: string[], inputType: InputType = 'document', callOpts: EmbedCallOptions = {}): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Every caller (ingest, the retry queue, remember, queries, the migrator) comes through here, so this is the one
    // place the text can leave the machine. Before the counts, so the size check, usage() and the waste pause all see
    // what is actually sent. Measured 2026-10-14 over 20,000 real observation texts (mean 866 B, a loaded shared
    // workstation): 77 µs a text (p50 49, p99 248, p99.9 712), 0.35% changed, none grew by more than 0.9%: ~10 ms for a
    // 128-text batch whose request takes 1.3-1.7 s. The caller's own text is never changed, only the copy sent.
    if (this.redactsInput) texts = texts.map(t => redactSecrets(t).text);
    const counts = texts.map(t => countTokens(t));
    if (this.maxInputTokens !== undefined) {
      const limit = this.maxInputTokens;
      const effectiveLimit = Math.floor(limit * TOKEN_COUNT_SAFETY_FACTOR);
      for (let i = 0; i < texts.length; i++) {
        if (counts[i]! > effectiveLimit) {
          throw new EmbedderInputTooLarge(counts[i]!, limit, i);
        }
      }
    }
    const source = callOpts.source ?? (inputType === 'query' ? 'query' : 'other');
    const timeoutMs = callOpts.patient ? this.patientTimeoutMs : this.timeoutMs;
    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      this.assertNotPaused(source);   // an earlier batch of this same call may have tripped it
      const batch = texts.slice(i, i + this.maxBatchSize);
      const batchTokens = counts.slice(i, i + this.maxBatchSize).reduce((a, b) => a + b, 0);
      const embeddings = await this.embedBatch(batch, inputType, batchTokens, timeoutMs, source);
      all.push(...embeddings);
    }
    return all;
  }

  private assertNotPaused(source: string): void {
    const until = this.pausedUntilMs();
    if (until) throw new EmbedderPaused(until, this.windowTokens());
    if (isInteractive(source)) this.assertWithinBudget();
  }

  /** Before an interactive request goes out. A request that finds the pause over but the hour still holding the spend
   *  trips it again: the window slides, it is not cleared (an answered probe must not hand a looping client a second
   *  budget, as it can for the waste, whose window is only evidence about the provider). */
  private assertWithinBudget(): void {
    if (this.budgetLimit <= 0) return;
    const now = Date.now();
    const used = this.interactiveWindowTokens(now);
    if (now >= this.budgetUntil) {
      if (used < this.budgetLimit) return;
      this.tripBudget(now, used);
    }
    throw new EmbedderBudgetExceeded(this.budgetUntil, used, this.budgetLimit);
  }

  /** The budget runs out: logged once per trip, not per refused request. */
  private tripBudget(now: number, used: number): void {
    this.budgetUntil = now + this.pauseMs;
    this.budgetTrips += 1;
    console.error(
      `[embedder] interactive token budget used up: ${used} of ${this.budgetLimit} tokens sent for searches, recalls and ` +
      `remember checks in the last hour. Until ${new Date(this.budgetUntil).toISOString()} they are not embedded ` +
      `(keyword search only); indexing is not affected. CAPTAIN_MEMO_EMBEDDER_INTERACTIVE_BUDGET_TOKENS raises it, 0 turns it off.`,
    );
  }

  /** Counts one request (every attempt, answered or not) in the ring, and trips the budget if it took the hour to the
   *  limit: the request that crosses is sent, the next one is refused, as with the waste. */
  private meter(source: string, tokens: number, now: number): void {
    const minute = Math.floor(now / 60_000);
    const slot = minute % RING_MINUTES;
    const at = slot * COLUMNS.length;
    if (this.ringMinute[slot] !== minute) {
      this.ringMinute[slot] = minute;
      this.ringCalls.fill(0, at, at + COLUMNS.length);
      this.ringTokens.fill(0, at, at + COLUMNS.length);
    }
    const col = columnOf(source);
    this.ringCalls[at + col]! += 1;
    this.ringTokens[at + col]! += tokens;
    if (!isInteractive(source)) return;
    let calls = 0, sent = 0;
    for (let c = 0; c < INTERACTIVE_SOURCES.length; c++) { calls += this.ringCalls[at + c]!; sent += this.ringTokens[at + c]!; }
    if (!this.busiest || sent > this.busiest.tokens) this.busiest = { at_epoch: minute * 60, calls, tokens: sent };
    if (this.budgetLimit > 0 && now >= this.budgetUntil) {
      const used = this.interactiveWindowTokens(now);
      if (used >= this.budgetLimit) this.tripBudget(now, used);
    }
  }

  /** Interactive tokens in the last RING_MINUTES minutes, this one included. */
  private interactiveWindowTokens(now: number): number {
    const minute = Math.floor(now / 60_000);
    let sum = 0;
    for (let slot = 0; slot < RING_MINUTES; slot++) {
      const m = this.ringMinute[slot]!;
      if (m <= minute - RING_MINUTES || m > minute) continue;
      for (let c = 0; c < INTERACTIVE_SOURCES.length; c++) sum += this.ringTokens[slot * COLUMNS.length + c]!;
    }
    return sum;
  }

  /** The last TAIL_MINUTES minutes in which something was sent, oldest first. A minute with nothing in it is left
   *  out and every minute is named by its absolute start, so an engine that has gone quiet reports the same thing
   *  from one tick to the next once the tail has emptied (makeUsageReporter then stops posting). */
  private tail(now: number): MinuteUsage[] {
    const minute = Math.floor(now / 60_000);
    const out: MinuteUsage[] = [];
    for (let m = minute - TAIL_MINUTES + 1; m <= minute; m++) {
      const slot = m % RING_MINUTES;
      if (this.ringMinute[slot] !== m) continue;
      const by_source: MinuteUsage['by_source'] = {};
      for (let c = 0; c < COLUMNS.length; c++) {
        const calls = this.ringCalls[slot * COLUMNS.length + c]!;
        if (calls > 0) by_source[COLUMNS[c]!] = { calls, tokens: this.ringTokens[slot * COLUMNS.length + c]! };
      }
      out.push({ at_epoch: m * 60, by_source });
    }
    return out;
  }

  private windowTokens(): number {
    return this.wasteWindow.reduce((n, w) => n + w.tokens, 0);
  }

  private pruneWaste(now: number): void {
    const cutoff = now - this.wasteWindowMs;
    while (this.wasteWindow.length > 0 && this.wasteWindow[0]!.at < cutoff) this.wasteWindow.shift();
  }

  private noteWaste(tokens: number): void {
    const now = Date.now();
    this.wastedTokens += tokens;
    this.wasteWindow.push({ at: now, tokens });
    this.pruneWaste(now);
    if (this.wasteLimit > 0 && this.windowTokens() >= this.wasteLimit) this.pausedUntil = now + this.pauseMs;
  }

  /** An answered request after a pause is the probe that ends it. */
  private noteAnswered(): void {
    if (this.pausedUntil !== 0 && Date.now() >= this.pausedUntil) {
      this.pausedUntil = 0;
      this.wasteWindow = [];
    }
  }

  private async embedBatch(
    texts: string[], inputType: InputType, tokens: number, timeoutMs: number, source: string,
  ): Promise<number[][]> {
    let attempt = 0;
    for (;;) {
      this.calls += 1;
      this.tokens += tokens;
      const s = (this.bySource[source] ??= { calls: 0, tokens: 0 });
      s.calls += 1;
      s.tokens += tokens;
      this.meter(source, tokens, Date.now());
      try {
        const out = await this.embedBatchOnce(texts, inputType, timeoutMs);
        this.noteAnswered();
        return out;
      } catch (err) {
        const e = err as Error;
        const timedOut = isTimeoutError(e);
        if (timedOut) this.aborted += 1;
        // A 4xx is refused before any work (bad key, bad input, throttled) and a refused connection never carried
        // the request: nothing was spent either way. Anything else that did not come back as a clean answer may
        // have been processed, and billed, for nothing.
        const refusedConnect = /unable to connect|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(e.message)
          || (e as { code?: string }).code === 'ConnectionRefused';
        if (!/HTTP 4\d\d/.test(e.message) && !refusedConnect) this.noteWaste(tokens);
        // Retry only a 5xx. Never after our own timeout: the provider may still be working on that request,
        // and sending it again is how one slow batch became three billed ones (3 attempts, 2026-10-08).
        if (timedOut || !/HTTP 5\d\d/.test(e.message)) throw e;
        attempt++;
        if (attempt >= this.maxRetries) throw e;
        await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt - 1)));
        this.assertNotPaused(source);
      }
    }
  }

  private async embedBatchOnce(texts: string[], inputType: InputType, timeoutMs: number): Promise<number[][]> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    let body: string;
    if (this.apiFormat === 'aelita') {
      if (this.apiKey) headers['x-aelita-token'] = this.apiKey;
      body = JSON.stringify({ texts, input_type: inputType });
    } else {
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      // input_type is a Captain Memo / Voyage extension; OpenAI-compatible
      // endpoints ignore unknown fields, so this is safe across all providers.
      // truncation:false makes Voyage hosted return HTTP 422 for oversized
      // inputs instead of silently tail-truncating; OpenAI-compat endpoints
      // ignore the field. Belt-and-suspenders with the local maxInputTokens
      // check above — that catches it before we even call out.
      body = JSON.stringify({
        input: texts,
        model: this.model,
        input_type: inputType,
        truncation: false,
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(e => {
          console.error(`[embedder] body-read failed for HTTP ${res.status}:`, (e as Error).message);
          return '';
        });
        throw new Error(`Embedder HTTP ${res.status}: ${body}`);
      }
      if (this.apiFormat === 'aelita') {
        const json = (await res.json()) as AelitaResponse;
        return json.embeddings;
      }
      const json = (await res.json()) as VoyageResponse;
      return json.data
        .sort((a, b) => a.index - b.index)
        .map(d => d.embedding);
    } finally {
      clearTimeout(timeout);
    }
  }
}
