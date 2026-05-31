import { readStdinJson, workerFetch, logHookError, logWorkerFailure } from './shared.ts';
import { DEFAULT_STOP_DRAIN_BUDGET_MS } from '../shared/paths.ts';

interface StopPayload {
  session_id?: string;
  stop_hook_active?: boolean;
}

export async function main(): Promise<void> {
  let payload: StopPayload = {};
  try { payload = await readStdinJson<StopPayload>(); } catch (err) { logHookError('Stop', err); return; }
  if (!payload.session_id) return;

  // The flush is the ONLY drain path for this session's queued observations — a
  // silently-failed flush is permanent loss for the session, so make it loud (logged).
  const res = await workerFetch('/observation/flush', {
    method: 'POST',
    body: { session_id: payload.session_id, max: 200 },
    timeoutMs: DEFAULT_STOP_DRAIN_BUDGET_MS,
  });
  logWorkerFailure('Stop', '/observation/flush', res);
}

if (import.meta.main) {
  main().catch((err) => {
    logHookError('Stop', err);
    process.exit(0);
  });
}
