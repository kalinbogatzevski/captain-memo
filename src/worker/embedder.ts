export type ApiFormat = 'openai' | 'aelita';

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

  constructor(opts: EmbedderOptions) {
    this.endpoint = opts.endpoint;
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.maxBatchSize = opts.maxBatchSize ?? 128;
    this.maxRetries = opts.maxRetries ?? 3;
    this.apiFormat = opts.apiFormat ?? 'openai';
  }

  async embed(texts: string[], inputType: InputType = 'document'): Promise<number[][]> {
    if (texts.length === 0) return [];
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
      body = JSON.stringify({ input: texts, model: this.model, input_type: inputType });
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
        throw new Error(`Embedder HTTP ${res.status}: ${await res.text()}`);
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
