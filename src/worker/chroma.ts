import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface ChromaClientOptions {
  dataDir: string;
}

export interface AddVectorInput {
  id: string;
  embedding: number[]; // Stored for future native-chromadb path; chroma-mcp embeds internally
  document: string;
  metadata: Record<string, unknown>;
}

export interface QueryResult {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  distance: number;
}

/**
 * Thin MCP-subprocess wrapper around chroma-mcp (via uvx).
 *
 * Architecture note: chroma-mcp embeds documents using its own default embedding function
 * (all-MiniLM-L6-v2, 384-dim). Raw embedding injection is not exposed by chroma-mcp's
 * MCP tool surface. The `embedding` field in AddVectorInput is accepted in the interface
 * for API compatibility and future use when aelita-mcp switches to a native chromadb
 * HTTP client, but is not forwarded to chroma-mcp (which would reject dimension mismatches).
 * Queries use text-based similarity via chroma-mcp's query_texts parameter.
 */
export class ChromaClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private dataDir: string;
  private connected = false;

  constructor(opts: ChromaClientOptions) {
    this.dataDir = opts.dataDir;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.transport = new StdioClientTransport({
      command: 'uvx',
      args: ['chroma-mcp', '--client-type', 'persistent', '--data-dir', this.dataDir],
    });
    this.client = new Client({ name: 'aelita-mcp-chroma', version: '0.1.0' }, { capabilities: {} });
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async ensureCollection(name: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    try {
      await this.client.callTool({
        name: 'chroma_get_collection_info',
        arguments: { collection_name: name },
      });
    } catch {
      await this.client.callTool({
        name: 'chroma_create_collection',
        arguments: { collection_name: name },
      });
    }
  }

  async add(collection: string, items: AddVectorInput[]): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    if (items.length === 0) return;

    // chroma-mcp rejects empty metadata dicts — only pass metadatas if at least one item has non-empty metadata
    const nonEmptyMetas = items.map(i => i.metadata).filter(m => Object.keys(m).length > 0);
    const args: Record<string, unknown> = {
      collection_name: collection,
      ids: items.map(i => i.id),
      documents: items.map(i => i.document),
    };
    if (nonEmptyMetas.length > 0) {
      args.metadatas = items.map(i => (Object.keys(i.metadata).length > 0 ? i.metadata : { _empty: true }));
    }

    const result = await this.client.callTool({ name: 'chroma_add_documents', arguments: args }) as any;
    if (result?.isError) {
      throw new Error(`chroma_add_documents failed: ${result?.content?.[0]?.text ?? 'unknown error'}`);
    }
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    if (ids.length === 0) return;
    const result = await this.client.callTool({
      name: 'chroma_delete_documents',
      arguments: { collection_name: collection, ids },
    }) as any;
    if (result?.isError) {
      throw new Error(`chroma_delete_documents failed: ${result?.content?.[0]?.text ?? 'unknown error'}`);
    }
  }

  /**
   * Query by text. chroma-mcp embeds the query text using the collection's embedding function
   * and returns results ranked by cosine distance.
   */
  async query(collection: string, queryText: string, topK: number): Promise<QueryResult[]> {
    if (!this.client) throw new Error('Not connected');
    const result = await this.client.callTool({
      name: 'chroma_query_documents',
      arguments: {
        collection_name: collection,
        query_texts: [queryText],
        n_results: topK,
      },
    }) as any;

    if (result?.isError) {
      throw new Error(`chroma_query_documents failed: ${result?.content?.[0]?.text ?? 'unknown error'}`);
    }

    // Response is a JSON string inside content[0].text
    const text = result?.content?.[0]?.text ?? '{}';
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`chroma_query_documents: unexpected response format: ${text}`);
    }

    // Chroma returns parallel arrays; extract index [0] (first — and only — query)
    const ids: string[] = parsed?.ids?.[0] ?? [];
    const docs: string[] = parsed?.documents?.[0] ?? [];
    const metas: Record<string, unknown>[] = parsed?.metadatas?.[0] ?? [];
    const distances: number[] = parsed?.distances?.[0] ?? [];

    return ids.map((id, idx) => ({
      id,
      document: docs[idx] ?? '',
      metadata: metas[idx] ?? {},
      distance: distances[idx] ?? 0,
    }));
  }

  async close(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    this.client = null;
    this.connected = false;
  }
}
