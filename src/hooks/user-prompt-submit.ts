import { readStdinJson, writeStdout, workerFetch, logHookError, logWorkerFailure, resolveProjectId } from './shared.ts';
import { DEFAULT_HOOK_TIMEOUT_MS, ENV_HOOK_TIMEOUT_MS } from '../shared/paths.ts';
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

  // Fire-and-forget revival: if the worker was unreachable, ask the OS supervisor
  // to start it. We await only the one-shot start command (bounded — fast for a
  // Type=simple systemd unit; a cold PowerShell start on Windows adds a sub-second
  // one-shot cost), never the /health probe — the supervisor owns the process.
  // Never re-checks the version. A rejected start is logged (start() throws on a
  // non-zero exit). The lock keeps concurrent prompts from stampeding the
  // supervisor. Opt out with CAPTAIN_MEMO_DISABLE_SELF_HEAL=1.
  if (!result.ok && process.env.CAPTAIN_MEMO_DISABLE_SELF_HEAL !== '1') {
    try {
      const { acquireHealLock, releaseHealLock } = await import('../shared/worker-heal-lock.ts');
      if (acquireHealLock()) {
        try {
          const { getServiceManager } = await import('../services/service-manager/index.ts');
          await getServiceManager().start('captain-memo-worker');
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
