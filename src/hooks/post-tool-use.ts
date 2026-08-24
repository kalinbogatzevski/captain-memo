import { readStdinJson, workerFetch, summarize, resolveProjectId, logHookError, logWorkerFailure, isMainModule } from './shared.ts';
import type { RawObservationEvent } from '../shared/types.ts';
import { detectBranchSync } from '../worker/branch.ts';
import { detectOriginAgent } from '../shared/origin-agent.ts';
import type { OriginAgent } from '../shared/origin-agent.ts';

interface PostToolUsePayload {
  session_id?: string;
  cwd?: string;
  prompt_number?: number;
  turn_id?: string;
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_output?: unknown;
}

// PostToolUse blocks Claude Code's tool-use hot path, so we want a tight
// budget — but 100 ms was so tight that on slower CPUs (or under embedder
// load) every enqueue silently aborted via AbortController, leaving the
// observations queue forever empty. 1 s gives realistic margin for a
// localhost POST + sqlite append, and is overridable via env.
const HOOK_TIMEOUT_MS = Number(process.env.CAPTAIN_MEMO_POST_TOOL_USE_TIMEOUT_MS ?? 1000);

/** Tools that CHANGE a file. Classification is by tool NAME because the name is authoritative and
 *  already in the payload — the previous version inferred it from the tool RESPONSE, asking whether it
 *  carried a `success` key. Claude Code's Edit/Write responses do not, so every file-touching tool was
 *  recorded as a read: `files_modified` was empty on all 122,885 observations of a live corpus while
 *  `files_read` was populated on half the events.
 *
 *  That mattered beyond tidiness. "Did this change something, or only look at something?" is the
 *  strongest ingest-time signal for whether an observation is worth keeping, and it is what separates
 *  "Fixed the race in dream-stats" from "Located SendMessage tool in captain-hub". Losing it left no
 *  usable basis for that judgement at all. */
const WRITING_TOOLS = new Set([
  'edit', 'write', 'multiedit', 'notebookedit', 'apply_patch',
  'write_file', 'writefile', 'replace', 'replace_file', 'strreplacefile',
]);

/** Codex exposes an opaque turn_id rather than a numeric prompt counter. A
 *  deterministic unsigned hash keeps every tool call from one turn grouped
 *  together without persisting hook-local state between processes. */
export function promptNumberFromTurnId(turnId: string | undefined): number {
  if (!turnId) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < turnId.length; i++) {
    hash ^= turnId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function patchFiles(input: unknown): string[] {
  const value = typeof input === 'string'
    ? input
    : input && typeof input === 'object'
      ? String((input as Record<string, unknown>).patch ?? (input as Record<string, unknown>).input ?? '')
      : '';
  const files: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/.exec(line);
    if (match?.[1]) files.push(match[1].trim());
  }
  return files;
}

export function extractFiles(
  toolName: string,
  input: unknown,
  _response: unknown,
): { read: string[]; modified: string[] } {
  const read: string[] = [];
  const modified: string[] = [];
  const ip = (input ?? {}) as Record<string, unknown>;
  if (typeof ip.file_path === 'string') {
    // Unknown tools degrade to READ: a false "modified" would overstate what happened, and this field
    // is meant to become a signal that decides what is kept.
    if (WRITING_TOOLS.has(toolName.toLowerCase())) modified.push(ip.file_path);
    else read.push(ip.file_path);
  }
  if (typeof ip.notebook_path === 'string') modified.push(ip.notebook_path);
  if (toolName.toLowerCase() === 'apply_patch') modified.push(...patchFiles(input));
  return { read, modified };
}

export interface PostToolUseOptions {
  originAgent?: OriginAgent;
  source?: string;
}

export async function main(options: PostToolUseOptions = {}): Promise<void> {
  let payload: PostToolUsePayload = {};
  try { payload = await readStdinJson<PostToolUsePayload>(); } catch (err) { logHookError('PostToolUse', err); return; }

  if (!payload.tool_name) return;
  const toolResponse = payload.tool_response ?? payload.tool_output;
  const { read, modified } = extractFiles(payload.tool_name, payload.tool_input, toolResponse);

  const event: RawObservationEvent = {
    session_id: payload.session_id ?? 'unknown',
    project_id: resolveProjectId(payload.cwd),
    prompt_number: payload.prompt_number ?? promptNumberFromTurnId(payload.turn_id),
    tool_name: payload.tool_name,
    tool_input_summary: summarize(payload.tool_input, 1500),
    tool_result_summary: summarize(toolResponse, 1500),
    files_read: read,
    files_modified: modified,
    ts_epoch: Math.floor(Date.now() / 1000),
    branch: detectBranchSync(payload.cwd ?? process.cwd()),
    origin_agent: options.originAgent ?? detectOriginAgent(),
    ...(options.source ? { source: options.source } : {}),
  };

  const res = await workerFetch('/observation/enqueue', {
    method: 'POST',
    body: event,
    timeoutMs: HOOK_TIMEOUT_MS,
  });
  logWorkerFailure('PostToolUse', '/observation/enqueue', res);
}

if (isMainModule(import.meta)) {
  try {
    await main();
  } catch (err) {
    logHookError('PostToolUse', err);
    process.exit(0);
  }
}
