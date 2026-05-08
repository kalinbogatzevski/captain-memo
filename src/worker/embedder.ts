export interface EmbedderOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  maxBatchSize?: number;
  maxRetries?: number;
}

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
}

export class Embedder {
  private endpoint: string;
  private model: string;
  private apiKey: string | undefined;
  private timeoutMs: number;
  private maxBatchSize: number;
  private maxRetries: number;

  constructor(opts: EmbedderOptions) {
    this.endpoint = opts.endpoint;
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.maxBatchSize = opts.maxBatchSize ?? 128;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      const embeddings = await this.embedBatch(batch);
      all.push(...embeddings);
    }
    return all;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    let attempt = 0;
    let lastErr: Error | null = null;

    while (attempt < this.maxRetries) {
      try {
        return await this.embedBatchOnce(texts);
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

  private async embedBatchOnce(texts: string[]): Promise<number[][]> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input: texts, model: this.model }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Voyage HTTP ${res.status}: ${await res.text()}`);
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
