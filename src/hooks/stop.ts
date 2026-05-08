import { readStdinJson, workerFetch, logHookError } from './shared.ts';
import { DEFAULT_STOP_DRAIN_BUDGET_MS } from '../shared/paths.ts';

interface StopPayload {
  session_id?: string;
  stop_hook_active?: boolean;
}

export async function main(): Promise<void> {
  let payload: StopPayload = {};
  try { payload = await readStdinJson<StopPayload>(); } catch { return; }
  if (!payload.session_id) return;

  await workerFetch('/observation/flush', {
    method: 'POST',
    body: { session_id: payload.session_id, max: 200 },
    timeoutMs: DEFAULT_STOP_DRAIN_BUDGET_MS,
  });
}

if (import.meta.main) {
  main().catch((err) => {
    logHookError('Stop', err);
    process.exit(0);
  });
}
