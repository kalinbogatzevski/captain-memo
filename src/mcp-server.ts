// src/mcp-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_WORKER_PORT } from './shared/paths.ts';

const WORKER_BASE = `http://localhost:${process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT}`;

async function workerPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${WORKER_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`worker ${path} returned ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

const TOOLS = [
  {
    name: 'search_memory',
    description: 'Search across local memory files (curated user memory). Returns top-K results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
        project: { type: 'string' },
        top_k: { type: 'number', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_skill',
    description: 'Search across skill bodies (section-level). Returns top-K matching sections.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        skill_id: { type: 'string' },
        top_k: { type: 'number', default: 3 },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_observations',
    description: 'Search across captured session observations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string', enum: ['bugfix', 'feature', 'refactor', 'discovery', 'decision', 'change'] },
        files: { type: 'array', items: { type: 'string' } },
        since: { type: 'string' },
        top_k: { type: 'number', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_all',
    description: 'Unified search across all configured channels (memory + skill + observation + remote). Returns merged top-K.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        channels: { type: 'array', items: { type: 'string', enum: ['memory', 'skill', 'observation', 'remote'] } },
        top_k: { type: 'number', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_full',
    description: 'Retrieve full content of a hit by its doc_id (returned in search results).',
    inputSchema: {
      type: 'object',
      properties: { doc_id: { type: 'string' } },
      required: ['doc_id'],
    },
  },
  {
    name: 'reindex',
    description: 'Trigger a reindex (admin). Optionally restrict to a channel or force re-embedding.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['memory', 'skill', 'observation', 'all'], default: 'all' },
        force: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'stats',
    description: 'Return corpus stats: total chunks, by channel, last index time, embedder info.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'status',
    description: 'Health check: are voyage and chroma reachable?',
    inputSchema: { type: 'object', properties: {} },
  },
];

// Exported so a `bin/captain-memo-mcp` shim can call this explicitly.
// Avoid gating on `import.meta.main` alone: when this file is imported
// (rather than invoked directly), `import.meta.main` is false and the
// server would silently never start.
export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'captain-memo', version: '0.1.0-alpha' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    let result: unknown;
    try {
      switch (name) {
        case 'search_memory':       result = await workerPost('/search/memory', args); break;
        case 'search_skill':        result = await workerPost('/search/skill', args); break;
        case 'search_observations': result = await workerPost('/search/observations', args); break;
        case 'search_all':          result = await workerPost('/search/all', args); break;
        case 'get_full':            result = await workerPost('/get_full', args); break;
        case 'reindex':             result = await workerPost('/reindex', args); break;
        case 'stats': {
          const res = await fetch(`${WORKER_BASE}/stats`);
          if (!res.ok) throw new Error(`worker /stats returned ${res.status}`);
          result = await res.json();
          break;
        }
        case 'status': {
          const res = await fetch(`${WORKER_BASE}/health`);
          result = res.ok ? await res.json() : { healthy: false };
          break;
        }
        default: throw new Error(`unknown tool: ${name}`);
      }
    } catch (err) {
      const e = err as Error;
      return {
        content: [{ type: 'text', text: `Error: ${e.message}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('captain-memo stdio MCP server connected');
}

// Run when invoked directly (e.g. `bun src/mcp-server.ts`). Keep the
// `import.meta.main` guard for direct-invocation convenience, but the function
// is exported above so wrapper scripts don't need this guard to be true.
if (import.meta.main) {
  runMcpServer().catch((err) => {
    console.error('captain-memo MCP server failed:', err);
    process.exit(1);
  });
}
