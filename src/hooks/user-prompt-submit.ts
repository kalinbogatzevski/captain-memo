import { readStdinJson, writeStdout, workerFetch, logHookError, logWorkerFailure, resolveProjectId } from './shared.ts';
import { DEFAULT_HOOK_TIMEOUT_MS, ENV_HOOK_TIMEOUT_MS, DEFAULT_WORKER_PORT } from '../shared/paths.ts';
import type { EnvelopePayload } from '../shared/types.ts';

interface UserPromptSubmitPayload {
  prompt?: string;
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
}

export async function main(): Promise<void> {
  let payload: UserPromptSubmitPayload = {};
  try {
    payload = await readStdinJson<UserPromptSubmitPayload>();
  } catch (err) {
    logHookError('UserPromptSubmit', err);
    return;
  }
  const prompt = payload.prompt ?? '';
  const timeoutMs = Number(process.env[ENV_HOOK_TIMEOUT_MS] ?? DEFAULT_HOOK_TIMEOUT_MS);

  const result = await workerFetch<EnvelopePayload>('/inject/context', {
    method: 'POST',
    body: {
      prompt,
      top_k: 5,
      session_id: payload.session_id,
      project_id: resolveProjectId(payload.cwd),
    },
    timeoutMs,
  });

  // A non-OK result means the memory envelope was dropped — log it (the prompt
  // still passes through bare below, so this stays fail-open). logWorkerFailure
  // no-ops on an OK result, so the normal "no hits" case (ok, no envelope) stays
  // quiet without an extra guard.
  logWorkerFailure('UserPromptSubmit', '/inject/context', result);

  // Fire-and-forget revival: if the worker was unreachable, RECLAIM-then-start via
  // the OS supervisor. Unreachable can mean a ZOMBIE (process alive, HTTP dead), so
  // a bare start would no-op on Windows (IgnoreNew while the corpse holds the task
  // "Running") — restartWorker force-kills whatever still holds the port first. We
  // await only this one-shot reclaim+start, never the /health probe; the supervisor
  // owns the process. Latency: instant on a systemd unit; on Windows the reclaim
  // polls the port (up to ~5s) but returns the moment the port frees, so a
  // successful kill is sub-second and only a stuck port pays the full budget. The
  // heal lock keeps concurrent prompts from stampeding the supervisor (and bounds
  // the worst case to one in-flight reclaim). Never re-checks the version. Opt out
  // with CAPTAIN_MEMO_DISABLE_SELF_HEAL=1.
  if (!result.ok && process.env.CAPTAIN_MEMO_DISABLE_SELF_HEAL !== '1') {
    try {
      const { acquireHealLock, releaseHealLock } = await import('../shared/worker-heal-lock.ts');
      if (acquireHealLock()) {
        try {
          const { getServiceManager } = await import('../services/service-manager/index.ts');
          const { restartWorker } = await import('../shared/worker-control.ts');
          const port = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
          await restartWorker(getServiceManager(), 'captain-memo-worker', { port });
        } finally {
          releaseHealLock();
        }
      }
    } catch (err) {
      logHookError('UserPromptSubmit', err);
    }
  }

  if (result.ok && result.body && result.body.envelope) {
    writeStdout(result.body.envelope);
    writeStdout('\n\n');
  }
  writeStdout(prompt);
}

if (import.meta.main) {
  main().catch((err) => {
    logHookError('UserPromptSubmit', err);
    process.exit(0);
  });
}
