import { countTokens } from '../shared/tokens.ts';

export type ApiFormat = 'openai' | 'aelita';

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

  private sinceEpoch = Math.floor(Date.now() / 1000);
  private calls = 0;
  private tokens = 0;
  private wastedTokens = 0;
  private aborted = 0;
  private bySource: Record<string, { calls: number; tokens: number }> = {};
  private wasteWindow: Array<{ at: number; tokens: number }> = [];
  private pausedUntil = 0;

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
  }

  /** When embedding resumes (epoch ms), or 0 when it is not paused. */
  pausedUntilMs(): number {
    return Date.now() < this.pausedUntil ? this.pausedUntil : 0;
  }

  usage(): EmbedUsage {
    this.pruneWaste(Date.now());
    const paused = this.pausedUntilMs();
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
    };
  }

  async embed(texts: string[], inputType: InputType = 'document', callOpts: EmbedCallOptions = {}): Promise<number[][]> {
    if (texts.length === 0) return [];
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
      this.assertNotPaused();   // an earlier batch of this same call may have tripped it
      const batch = texts.slice(i, i + this.maxBatchSize);
      const batchTokens = counts.slice(i, i + this.maxBatchSize).reduce((a, b) => a + b, 0);
      const embeddings = await this.embedBatch(batch, inputType, batchTokens, timeoutMs, source);
      all.push(...embeddings);
    }
    return all;
  }

  private assertNotPaused(): void {
    const until = this.pausedUntilMs();
    if (until) throw new EmbedderPaused(until, this.windowTokens());
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
        this.assertNotPaused();
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
