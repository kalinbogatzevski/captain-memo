// src/mcp-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { customAlphabet } from 'nanoid';
import { DEFAULT_WORKER_PORT } from './shared/paths.ts';
import { loadWorkerEnv } from './shared/worker-env.ts';
import { VERSION } from './shared/version.ts';

// Seed worker.env so a custom CAPTAIN_MEMO_WORKER_PORT set there is honored even
// when Claude Code launches the MCP server without that var in its environment.
loadWorkerEnv();

const WORKER_BASE = `http://localhost:${process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT}`;

// Fallback session id for work_set/work_active/work_clear when the caller omits session_id —
// one per MCP server process, so a tool call without an explicit id still has a stable identity.
const _sid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);
const PROCESS_SESSION_ID = `mcp-${_sid()}`;

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

export const TOOLS = [
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
    name: 'remember',
    description:
      'Persist a durable, curated memory entry worth recalling in future sessions — a decision, preference, convention, or hard-won fact — NOT ephemeral scratch or transient task state. Writes a markdown entry into the current project\'s curated memory and indexes it immediately. Provide the substance in `body` and a `type` (e.g. decision, preference, feedback, reference); `name`, `description`, and `slug` are optional and auto-generated when omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string' },
        type: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        slug: { type: 'string' },
      },
      required: ['body', 'type'],
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
  {
    name: 'work_set',
    description:
      'Coordination board: publish or refresh a transient claim that YOU are working on something right now, then immediately get back any OTHER active sessions whose files overlap yours. Call this before diving into a codebase area, and re-call periodically (it is a heartbeat that keeps the lease alive). Other AI sessions on this machine (Claude, Codex, Gemini, Cursor all share one captain) see your claim at once. Pass `agent` so the claim reads "codex on this captain", and `files` as the globs you will touch ("billing/**", "src/auth/login.ts"). Claims are advisory leases, not locks — they auto-expire (default 30 min) so a crashed session never blocks an area. Returns { session_id, overlaps[] }; if overlaps is non-empty, another session is in the same files — coordinate before editing.',
    inputSchema: {
      type: 'object',
      properties: {
        what: { type: 'string', description: 'Short description, e.g. "refactoring the billing module".' },
        files: { type: 'array', items: { type: 'string' }, description: 'Globs you will touch, e.g. ["billing/**"].' },
        agent: { type: 'string', description: 'Your AI label: claude | codex | gemini | cursor.' },
        ttl_s: { type: 'number', description: 'Lease seconds (default 1800, clamped 60..28800).' },
        session_id: { type: 'string', description: 'Stable id for your session; omit to use this MCP process default.' },
      },
      required: ['what'],
    },
  },
  {
    name: 'work_active',
    description:
      'Coordination board: list the live work claims on this captain and, if you pass your session_id, which of them overlap your own claimed files. Call this to see who else is working where before you start.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Your session id, to compute overlaps_with_mine; omit to use this MCP process default.' },
      },
    },
  },
  {
    name: 'work_clear',
    description: 'Coordination board: drop your work claim when the task is done (releases the lease immediately instead of waiting for it to expire).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id to clear; omit to clear this MCP process default.' },
      },
    },
  },
];

/** Arguments the `remember` MCP tool accepts from the model (cwd is injected, not accepted). */
export interface RememberToolArgs {
  body: string;
  type: string;
  name?: string;
  description?: string;
  slug?: string;
}

/** Worker `POST /remember` response — mirrors WriteMemoryResult (src/worker/memory-writer.ts). */
type RememberWorkerResult =
  | { ok: true; path: string; action: 'created' | 'updated'; doc_id: string }
  | { ok: false; reason: string };

/** Build the `POST /remember` request body: forward the model's fields verbatim and
 *  inject the session's project cwd (flat `cwd`, matching the worker's RememberSchema).
 *  Absent optionals are omitted (no `undefined` keys reach the worker). */
export function buildRememberRequest(
  args: RememberToolArgs,
  cwd: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    body: args.body,
    type: args.type,
    cwd,
  };
  if (args.name !== undefined) out.name = args.name;
  if (args.description !== undefined) out.description = args.description;
  if (args.slug !== undefined) out.slug = args.slug;
  return out;
}

/** Turn a worker WriteMemoryResult into the model-facing MCP tool response.
 *  Success → action + path text; ok:false → an MCP error carrying the reason. */
export function formatRememberResult(
  result: RememberWorkerResult,
): { content: { type: 'text'; text: string }[]; isError?: true } {
  if (!result.ok) {
    return {
      content: [{ type: 'text', text: `Error: ${result.reason}` }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: `Memory ${result.action}: ${result.path}` }],
  };
}

/** Orchestrate the remember tool: inject cwd, POST /remember, format the result.
 *  `deps` is injectable so unit tests need neither a live worker nor the real cwd. */
export async function dispatchRemember(
  args: RememberToolArgs,
  deps: {
    post: (path: string, body: unknown) => Promise<unknown>;
    cwd: () => string;
  },
): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
  const body = buildRememberRequest(args, deps.cwd());
  const result = (await deps.post('/remember', body)) as RememberWorkerResult;
  return formatRememberResult(result);
}

// Exported so a `bin/captain-memo-mcp` shim can call this explicitly.
// Avoid gating on `import.meta.main` alone: when this file is imported
// (rather than invoked directly), `import.meta.main` is false and the
// server would silently never start.
export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'captain-memo', version: VERSION },
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
        case 'remember':
          return await dispatchRemember(args as unknown as RememberToolArgs, {
            post: workerPost,
            cwd: () => process.cwd(),
          });
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
        case 'work_set': {
          const a = (args ?? {}) as { session_id?: string };
          result = await workerPost('/worknote/set', { ...a, session_id: a.session_id || PROCESS_SESSION_ID });
          break;
        }
        case 'work_active': {
          const a = (args ?? {}) as { session_id?: string };
          const q = new URLSearchParams({ session_id: a.session_id || PROCESS_SESSION_ID });
          const res = await fetch(`${WORKER_BASE}/worknote/active?${q.toString()}`);
          if (!res.ok) throw new Error(`worker /worknote/active returned ${res.status}`);
          result = await res.json();
          break;
        }
        case 'work_clear': {
          const a = (args ?? {}) as { session_id?: string };
          result = await workerPost('/worknote/clear', { session_id: a.session_id || PROCESS_SESSION_ID });
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
