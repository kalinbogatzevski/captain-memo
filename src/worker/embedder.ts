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

export interface EmbedderOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
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

export class Embedder {
  private endpoint: string;
  private model: string;
  private apiKey: string | undefined;
  private timeoutMs: number;
  private maxBatchSize: number;
  private maxRetries: number;
  private apiFormat: ApiFormat;
  private maxInputTokens: number | undefined;

  constructor(opts: EmbedderOptions) {
    this.endpoint = opts.endpoint;
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.maxBatchSize = opts.maxBatchSize ?? 128;
    this.maxRetries = opts.maxRetries ?? 3;
    this.apiFormat = opts.apiFormat ?? 'openai';
    this.maxInputTokens = opts.maxInputTokens;
  }

  async embed(texts: string[], inputType: InputType = 'document'): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (this.maxInputTokens !== undefined) {
      const limit = this.maxInputTokens;
      const effectiveLimit = Math.floor(limit * TOKEN_COUNT_SAFETY_FACTOR);
      for (let i = 0; i < texts.length; i++) {
        const estimated = countTokens(texts[i]!);
        if (estimated > effectiveLimit) {
          throw new EmbedderInputTooLarge(estimated, limit, i);
        }
      }
    }
    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      const embeddings = await this.embedBatch(batch, inputType);
      all.push(...embeddings);
    }
    return all;
  }

  private async embedBatch(texts: string[], inputType: InputType): Promise<number[][]> {
    let attempt = 0;
    let lastErr: Error | null = null;

    while (attempt < this.maxRetries) {
      try {
        return await this.embedBatchOnce(texts, inputType);
      } catch (err) {
        const e = err as Error;
        lastErr = e;
        // Retry only on 5xx-style transient failures or timeouts
        const is5xx = /HTTP 5\d\d/.test(e.message);
        const isTimeout = e.name === 'AbortError' || /aborted/i.test(e.message);
        if (!(is5xx || isTimeout)) throw e;
        attempt++;
        if (attempt >= this.maxRetries) throw e;
        const backoffMs = 100 * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
    throw lastErr ?? new Error('embedBatch: unreachable');
  }

  private async embedBatchOnce(texts: string[], inputType: InputType): Promise<number[][]> {
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
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

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
