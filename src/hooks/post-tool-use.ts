import { readStdinJson, workerFetch, summarize, resolveProjectId } from './shared.ts';
import type { RawObservationEvent } from '../shared/types.ts';

interface PostToolUsePayload {
  session_id?: string;
  cwd?: string;
  prompt_number?: number;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

const HOOK_TIMEOUT_MS = 100;

function extractFiles(input: unknown, response: unknown): { read: string[]; modified: string[] } {
  const read: string[] = [];
  const modified: string[] = [];
  const ip = (input ?? {}) as Record<string, unknown>;
  const rp = (response ?? {}) as Record<string, unknown>;
  if (typeof ip.file_path === 'string') {
    if (rp && typeof rp === 'object' && 'success' in rp) modified.push(ip.file_path);
    else read.push(ip.file_path);
  }
  if (typeof ip.notebook_path === 'string') modified.push(ip.notebook_path);
  return { read, modified };
}

async function main(): Promise<void> {
  let payload: PostToolUsePayload = {};
  try { payload = await readStdinJson<PostToolUsePayload>(); } catch { return; }

  if (!payload.tool_name) return;
  const { read, modified } = extractFiles(payload.tool_input, payload.tool_response);

  const event: RawObservationEvent = {
    session_id: payload.session_id ?? 'unknown',
    project_id: resolveProjectId(payload.cwd),
    prompt_number: payload.prompt_number ?? 0,
    tool_name: payload.tool_name,
    tool_input_summary: summarize(payload.tool_input, 1500),
    tool_result_summary: summarize(payload.tool_response, 1500),
    files_read: read,
    files_modified: modified,
    ts_epoch: Math.floor(Date.now() / 1000),
  };

  await workerFetch('/observation/enqueue', {
    method: 'POST',
    body: event,
    timeoutMs: HOOK_TIMEOUT_MS,
  });
}

if (import.meta.main) {
  main().catch(() => process.exit(0));
}
