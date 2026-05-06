export interface VoyageEmbedderOptions {
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

export class VoyageEmbedder {
  private endpoint: string;
  private model: string;
  private apiKey: string | undefined;
  private timeoutMs: number;
  private maxBatchSize: number;

  constructor(opts: VoyageEmbedderOptions) {
    this.endpoint = opts.endpoint;
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.maxBatchSize = opts.maxBatchSize ?? 128;
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
