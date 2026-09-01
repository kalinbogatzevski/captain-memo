import { readStdinJson, writeStdout, workerFetch, logHookError, logWorkerFailure, isMainModule } from './shared.ts';
import { DEFAULT_STOP_DRAIN_BUDGET_MS } from '../shared/paths.ts';
import { consumeSessionDegraded } from '../shared/worker-transition.ts';

interface StopPayload {
  session_id?: string;
  stop_hook_active?: boolean;
}

export interface StopOptions { emitJson?: boolean }

export async function main(options: StopOptions = {}): Promise<void> {
  let payload: StopPayload = {};
  try { payload = await readStdinJson<StopPayload>(); } catch (err) {
    logHookError('Stop', err);
    if (options.emitJson) writeStdout('{}');
    return;
  }
  if (!payload.session_id) {
    if (options.emitJson) writeStdout('{}');
    return;
  }

  // The flush is the ONLY drain path for this session's queued observations — a
  // silently-failed flush is permanent loss for the session, so make it loud (logged).
  const res = await workerFetch('/observation/flush', {
    method: 'POST',
    body: { session_id: payload.session_id, max: 200 },
    timeoutMs: DEFAULT_STOP_DRAIN_BUDGET_MS,
  });
  logWorkerFailure('Stop', '/observation/flush', res);

  // The other half of the "worker unreachable" story. SessionStart's banner is a ONE-SHOT statement —
  // a session that opened while the worker was restarting keeps reading "memory is paused" long after
  // it came back, which is why sessions were being closed and reopened by hand. This flush is already
  // a live round-trip to the worker on every turn end, so an OK result IS the recovery signal: no
  // extra probe, and the flag (raised by SessionStart, per session) makes it fire exactly once.
  // Vendor hosts (Codex/Gemini, emitJson) keep their verified '{}' — their systemMessage contract is
  // not confirmed. The flag is only CONSUMED on the path that can actually show it: consuming it
  // first would destroy the notice on a host that then prints '{}', so the session that was told
  // memory was down would never hear it came back.
  if (options.emitJson) { writeStdout('{}'); return; }
  if (res.ok && consumeSessionDegraded(payload.session_id)) {
    writeStdout(JSON.stringify({
      systemMessage: '⚓ Captain Memo is back online — memory is active again for this session.',
    }));
  }
}

if (isMainModule(import.meta)) {
  try {
    await main();
  } catch (err) {
    logHookError('Stop', err);
    process.exit(0);
  }
}
