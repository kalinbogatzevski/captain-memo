import { readStdinJson, workerFetch, summarize, resolveProjectId, logHookError } from './shared.ts';
import type { RawObservationEvent } from '../shared/types.ts';
import { detectBranchSync } from '../worker/branch.ts';

interface PreCompactPayload {
  session_id?: string;
  cwd?: string;
  trigger?: string;
  transcript_path?: string;
  [key: string]: unknown;
}

// PreCompact fires before context compaction — a latency-sensitive path.
// 5 s is generous enough for a localhost POST while still yielding quickly.
const HOOK_TIMEOUT_MS = Number(process.env.CAPTAIN_MEMO_PRE_COMPACT_TIMEOUT_MS ?? 5000);

export async function main(): Promise<void> {
  let payload: PreCompactPayload = {};
  try { payload = await readStdinJson<PreCompactPayload>(); } catch { return; }

  const event: RawObservationEvent = {
    session_id: payload.session_id ?? 'unknown',
    project_id: resolveProjectId(payload.cwd),
    prompt_number: 0,
    tool_name: 'pre-compact',
    tool_input_summary: '',
    tool_result_summary: summarize(payload, 2000),
    files_read: [],
    files_modified: [],
    ts_epoch: Math.floor(Date.now() / 1000),
    branch: detectBranchSync(process.cwd()),
    source: 'pre-compact',
  };

  await workerFetch('/observation/enqueue', {
    method: 'POST',
    body: event,
    timeoutMs: HOOK_TIMEOUT_MS,
  });
}

if (import.meta.main) {
  main().catch((err) => {
    logHookError('PreCompact', err);
    process.exit(0);
  });
}
