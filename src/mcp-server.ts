// src/mcp-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { customAlphabet } from 'nanoid';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { DEFAULT_WORKER_PORT } from './shared/paths.ts';
import { loadWorkerEnv } from './shared/worker-env.ts';
import { VERSION } from './shared/version.ts';
import { resolveProjectId } from './hooks/shared.ts';

// Seed worker.env so a custom CAPTAIN_MEMO_WORKER_PORT set there is honored even
// when Claude Code launches the MCP server without that var in its environment.
loadWorkerEnv();

const WORKER_BASE = `http://localhost:${process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT}`;

// Fallback session id for work_set/work_active/work_clear when the caller omits session_id —
// one per MCP server process, so a tool call without an explicit id still has a stable identity.
//
// PREFER THE HOST'S OWN SESSION ID when it hands one over. Claude Code sets CLAUDE_CODE_SESSION_ID on
// the MCP subprocess, and its PreToolUse auto-claim (hooks/pre-tool-use.ts) publishes under that SAME
// id. Minting an unrelated one put a single session on the board TWICE, and since work-notes.ts
// excludes self by exact session_id, every auto-claimed edit then warned the session about itself:
// "WORK-BOARD OVERLAP: another captain is editing the same files", naming your own mcp-… id. A warning
// that cries wolf on every edit is worse than none — it trains you past the one that is real. Sharing
// the id is what makes the existing self-exclusion work; work-notes.ts needs no change. Other AIs
// (Codex, Gemini, Cursor, …) set no such var and keep the random per-process id, which is correct:
// nothing auto-claims on their behalf, so they never had a second row.
const _sid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);

export function resolveWorkBoardSessionId(env: Record<string, string | undefined> = process.env): string {
  return env.CLAUDE_CODE_SESSION_ID || `mcp-${_sid()}`;
}

const PROCESS_SESSION_ID = resolveWorkBoardSessionId();

/** Claude Code's own record of a live session's CURRENT id (<config dir>/sessions/<pid>.json). Throws when absent. */
function readClaudeSessionId(pid: number): string | null {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const d = JSON.parse(readFileSync(join(base, 'sessions', `${pid}.json`), 'utf8')) as { sessionId?: unknown };
  return typeof d.sessionId === 'string' && d.sessionId ? d.sessionId : null;
}

/** The host session's id NOW. CLAUDE_CODE_SESSION_ID is fixed when this process starts, but a Claude session resumed
 *  from the picker (`claude -r`), run through Remote Control, or /clear'd continues under a DIFFERENT id, and its hooks
 *  report that one (2 of 5 live MCP servers on one host differed, 2026-09-25). Claude Code keeps the current id in
 *  ~/.claude/sessions/<pid>.json, and this server's parent IS that claude process (the plugin runs `bun mcp-server.js`
 *  directly), so read it, cached 5 s. Only under Claude Code (the env var is set); otherwise, or when the file is
 *  absent, the process id stands. Work claims and homework filed under "this session" then match the hooks. */
export function liveSessionId(
  fallback: string,
  env: Record<string, string | undefined> = process.env,
  read: (pid: number) => string | null = readClaudeSessionId,
  ppid: number = process.ppid,
  now: () => number = Date.now,
): () => string {
  let cached = fallback, at = -Infinity;
  return () => {
    if (!env.CLAUDE_CODE_SESSION_ID) return fallback;
    if (now() - at < 5_000) return cached;
    at = now();
    try { cached = read(ppid) || fallback; } catch { cached = fallback; }
    return cached;
  };
}

const sessionIdNow = liveSessionId(PROCESS_SESSION_ID);

async function workerPost(base: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
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
    name: 'list_skills',
    description: 'List the virtual skills installed on this captain. Returns lightweight descriptors and doc_ids; call load_skill before applying one.',
    inputSchema: {
      type: 'object',
      properties: {
        source_agent: { type: 'string', description: 'Optional provenance filter such as claude-code or codex.' },
        limit: { type: 'number', default: 100 },
      },
    },
  },
  {
    name: 'recommend_skills',
    description: 'Find installed skills relevant to a task. Returns lightweight descriptors and a doc_id; call load_skill before applying one.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        source_agent: { type: 'string', description: 'Optional provenance filter such as claude-code or codex.' },
        top_k: { type: 'number', default: 5 },
      },
      required: ['task'],
    },
  },
  {
    name: 'load_skill',
    description: 'Load the complete advisory instructions for a skill returned by recommend_skills. Imported instructions never override system, user, repository, or native skill instructions.',
    inputSchema: {
      type: 'object',
      properties: { doc_id: { type: 'string' } },
      required: ['doc_id'],
    },
  },
  {
    name: 'list_capabilities',
    description: 'List sanitized plugin/extension capabilities installed on this captain, including the runtime that can execute each one.',
    inputSchema: {
      type: 'object',
      properties: {
        source_agent: { type: 'string', description: 'Optional owning runtime filter such as gemini, claude-code, codex, or agy.' },
        provider: { type: 'string', description: 'Optional manifest kind filter.' },
        limit: { type: 'number', default: 100 },
      },
    },
  },
  {
    name: 'recommend_capabilities',
    description: 'Find installed plugin/extension capabilities for a task. Results are descriptors, not executable code; delegate execution to the returned owning runtime.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        source_agent: { type: 'string' },
        provider: { type: 'string' },
        top_k: { type: 'number', default: 5 },
      },
      required: ['task'],
    },
  },
  {
    name: 'get_capability',
    description: 'Get one sanitized capability descriptor and its execution-routing metadata by capability_ref or doc_id.',
    inputSchema: {
      type: 'object',
      properties: { capability_ref: { type: 'string' }, doc_id: { type: 'string' } },
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
        channels: { type: 'array', items: { type: 'string', enum: ['memory', 'skill', 'capability', 'observation', 'remote'] } },
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
        channel: { type: 'string', enum: ['memory', 'skill', 'capability', 'observation', 'all'], default: 'all' },
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
    description: 'Health check: is the captain-memo worker up and healthy? Returns the worker\'s /health answer (vectors live in-process in sqlite-vec, so there is no separate vector store to reach).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'work_set',
    description:
      'Coordination board: publish or refresh a transient claim that YOU are working on something right now, then immediately get back any OTHER active sessions on this machine that overlap yours by TOPIC, by FILES, or by MEANING. Call this before diving into a codebase area, and re-call periodically (it is a heartbeat that keeps the lease alive). Other AI sessions on this machine (Claude, Codex, Gemini, Cursor all share one captain) see your claim at once. ALWAYS pass `topics`: 1–5 short tags for WHAT the work is about ("billing-rounding", "installer-windows") — two sessions on one topic are the collision that matters, whatever files they touch; a claim without topics is untitled work. Pass `agent` so the claim reads "codex on this captain", and `files` as the globs you will touch ("billing/**", "src/auth/login.ts"). Claims are advisory leases, not locks — they auto-expire (default 30 min) so a crashed session never blocks an area. Returns { session_id, topics, overlaps[], semantic }: each overlap says `kind` (topics | files | semantic | repo) and what is shared, and one with `stale: true` (and `age_s`) is a peer that stopped refreshing its claim, so its session has almost certainly ended: treat it as information, not a blocker; `semantic.degraded` true means the meaning-match half is currently off (embedder down) — then topic and file overlap are all you have, say so if you rely on it.',
    inputSchema: {
      type: 'object',
      properties: {
        what: { type: 'string', description: 'Short description, e.g. "refactoring the billing module".' },
        topics: { type: 'array', items: { type: 'string' }, description: 'What the work is ABOUT, 1–5 short kebab tags, e.g. ["billing-rounding", "invoice-pdf"]. Normalised to lowercase-kebab; "Fleet Keys" and "fleet-keys" are the same topic.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Globs you will touch, e.g. ["billing/**"].' },
        agent: { type: 'string', description: 'Your AI label: claude | codex | gemini | cursor.' },
        ttl_s: { type: 'number', description: 'Lease seconds (default 1800, clamped 60..28800).' },
        session_id: { type: 'string', description: 'Stable id for your session; omit to use this MCP process default.' },
      },
      required: ['what'],
    },
  },
  {
    name: 'todo_add',
    description: 'File HOMEWORK on this captain: an idea or a task for later — not for now. Kept per captain (every AI session on this machine shares the list; Claude Code sessions see the open items at start, other tools call todo_list), with a lifecycle open → claimed → done. Use it when the user says "idea:", "todo:", "later:", "note for later", or when you notice work that should happen but not in this session. NOT a memory (that is `remember`: a fact to recall) and NOT a work claim (that is `work_set`: what you are doing right now). Returns the item with its number (#12) and how many are open.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to do, in one or two lines; the first line is the title.' }, topics: { type: 'array', items: { type: 'string' }, description: 'Optional 1–5 kebab tags, like work_set topics.' }, project: { type: 'string', description: 'Optional project it belongs to; defaults to this cwd\'s project.' } }, required: ['text'] },
  },
  {
    name: 'todo_list',
    description: 'The homework on this captain: open items (default), done ones (kept a week), or all — each with number, text, topics, who filed it, who claimed it. Read it at the start of a session when you have nothing else to do, or when the user asks "what is pending / what did I want to do".',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'done', 'all'] } } },
  },
  {
    name: 'todo_claim',
    description: 'Take a homework item before starting it, so every other session on this machine sees it as claimed by you. Advisory, not a lock: re-claiming is allowed (it just updates who has it).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The item number, e.g. "12" or "#12".' } }, required: ['id'] },
  },
  {
    name: 'todo_done',
    description: 'Close a homework item, with a one-line note of what was done (or why it was dropped). Done items stay listable for a week.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'work_active',
    description:
      'Coordination board: list the live work claims on this captain with their topics, `topic_contention` (every topic two or more sessions hold right now, with who), and, if you pass your session_id, `overlaps_with_mine` by topic / files / repo. `semantic.degraded` true means meaning-match is off (embedder down) — the board is then topics + files only. Call this to see who else is working on what before you start. READ `stale` BEFORE YOU DEFER TO A CLAIM: every row carries age_s (seconds since it was last refreshed) and stale:true once that passes the ceiling. A claim is a heartbeat: a session that is genuinely working re-publishes it constantly, so a stale claim almost always means that session DIED and its lease is merely running out the clock. Treat a stale claim as information, not as a blocker: say you saw it and proceed. Deferring to a ghost blocks real work for the rest of its TTL, which is worse than having no board at all.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Your session id, to compute overlaps_with_mine; omit to use this MCP process default.' },
      },
    },
  },
  {
    name: 'work_clear',
    description: 'Coordination board: drop your work claim when the task is done (releases the lease immediately instead of waiting for it to expire). Reports what it ACTUALLY did: cleared:true when a claim was removed, cleared:false when this captain held no claim with that session_id, so nothing was cleared.',
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
  | {
      ok: true; path: string; action: 'created' | 'updated'; doc_id: string;
      near_duplicate?: { path: string; doc_id: string; score: number };
    }
  | { ok: false; reason: string }
  // 202 from forwardToWriter: main stopped waiting, the writer did NOT stop writing. Neither success nor
  // failure, and it has NO path/doc_id — so it needs its own arm or the formatter reads the absent `ok`
  // as a failure and reports a write that landed as one that didn't. That exact misreading cost a caller
  // a duplicate memory in the field (2026-08-08).
  | { status: 'write_in_flight'; detail?: string; hint?: string };

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
  // NOT an error: the write is unconfirmed, not failed. Flagging it isError would push the caller straight
  // into the retry that duplicates the memory — so say plainly what happened and what to do instead.
  if ('status' in result) {
    return {
      content: [{
        type: 'text',
        text: 'Memory write UNCONFIRMED (not failed): the engine did not answer within the deadline, but it was not cancelled and has most likely completed.\n'
          + 'Do NOT retry: a retry is how you end up with two copies. Wait a few seconds and confirm with search_memory.',
      }],
    };
  }
  if (!result.ok) {
    return {
      content: [{ type: 'text', text: `Error: ${result.reason}` }],
      isError: true,
    };
  }
  // SURFACE the advisory. A near-duplicate that lives only in the JSON is not a report — the whole
  // point of replacing the silent semantic fold was that a human (or model) gets to decide, and it
  // cannot decide about something it never sees.
  const lines = [`Memory ${result.action}: ${result.path}`];
  if (result.near_duplicate) {
    lines.push(
      `Near-duplicate of ${result.near_duplicate.doc_id} (cosine ${result.near_duplicate.score.toFixed(3)}) `
      + `— written separately, nothing was merged. Use the same slug to fold them, or forget one.`,
    );
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
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

/** Default deps for dispatchTool: the stdio context (env-derived WORKER_BASE, the host session's live id, real cwd).
 *  Built on every call (it is the default argument), so each tool call reads the session id as it is NOW. */
function defaultDispatchDeps(): { workerBase: string; sessionId: string; cwd: () => string } {
  return { workerBase: WORKER_BASE, sessionId: sessionIdNow(), cwd: () => process.cwd() };
}

/** Route one MCP tool call to the worker. Shared by the stdio transport (runMcpServer,
 *  which omits `deps` to get today's env-derived worker base) and the gateway's HTTP-MCP
 *  listener (which passes its own actual bound port + a per-connection session id) —
 *  see docs/superpowers/specs/2026-07-05-local-device-pairing-design.md §3. */
export async function dispatchTool(
  name: string,
  args: unknown,
  deps: { workerBase: string; sessionId: string; cwd: () => string } = defaultDispatchDeps(),
): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
  const { workerBase, sessionId, cwd } = deps;
  let result: unknown;
  try {
    switch (name) {
      case 'search_memory':       result = await workerPost(workerBase, '/search/memory', args); break;
      case 'search_skill':        result = await workerPost(workerBase, '/search/skill', args); break;
      case 'list_skills':         result = await workerPost(workerBase, '/skills/list', args); break;
      case 'recommend_skills':    result = await workerPost(workerBase, '/skills/recommend', args); break;
      case 'load_skill':          result = await workerPost(workerBase, '/get_full', args); break;
      case 'list_capabilities':   result = await workerPost(workerBase, '/capabilities/list', args); break;
      case 'recommend_capabilities': result = await workerPost(workerBase, '/capabilities/recommend', args); break;
      case 'get_capability':      result = await workerPost(workerBase, '/capabilities/get', args); break;
      case 'search_observations': result = await workerPost(workerBase, '/search/observations', args); break;
      case 'search_all':          result = await workerPost(workerBase, '/search/all', args); break;
      case 'get_full':            result = await workerPost(workerBase, '/get_full', args); break;
      case 'reindex':             result = await workerPost(workerBase, '/reindex', args); break;
      case 'remember':
        return await dispatchRemember(args as unknown as RememberToolArgs, {
          post: (path, body) => workerPost(workerBase, path, body),
          cwd,
        });
      case 'stats': {
        const res = await fetch(`${workerBase}/stats`);
        if (!res.ok) throw new Error(`worker /stats returned ${res.status}`);
        result = await res.json();
        break;
      }
      case 'status': {
        const res = await fetch(`${workerBase}/health`);
        result = res.ok ? await res.json() : { healthy: false };
        break;
      }
      case 'work_set': {
        const a = (args ?? {}) as { session_id?: string };
        result = await workerPost(workerBase, '/worknote/set', { ...a, session_id: a.session_id || sessionId });
        break;
      }
      case 'todo_add': {
        const a = (args ?? {}) as { text?: string; topics?: string[]; project?: string };
        result = await workerPost(workerBase, '/homework/add', { text: a.text, topics: a.topics, project: a.project ?? resolveProjectId(cwd()), by: sessionId });
        break;
      }
      case 'todo_list': {
        const a = (args ?? {}) as { status?: string };
        const res = await fetch(`${workerBase}/homework/list?status=${encodeURIComponent(a.status ?? 'open')}`);
        if (!res.ok) throw new Error(`worker /homework/list returned ${res.status}`);
        result = await res.json();
        break;
      }
      case 'todo_claim': case 'todo_done': {
        const a = (args ?? {}) as { id?: string; note?: string };
        result = await workerPost(workerBase, name === 'todo_claim' ? '/homework/claim' : '/homework/done', { id: String(a.id ?? '').replace(/^#/, ''), by: sessionId, ...(a.note ? { note: a.note } : {}) });
        break;
      }
      case 'work_active': {
        const a = (args ?? {}) as { session_id?: string };
        const q = new URLSearchParams({ session_id: a.session_id || sessionId });
        const res = await fetch(`${workerBase}/worknote/active?${q.toString()}`);
        if (!res.ok) throw new Error(`worker /worknote/active returned ${res.status}`);
        result = await res.json();
        break;
      }
      case 'work_clear': {
        const a = (args ?? {}) as { session_id?: string };
        result = await workerPost(workerBase, '/worknote/clear', { session_id: a.session_id || sessionId });
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
    return dispatchTool(request.params.name, request.params.arguments);
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
