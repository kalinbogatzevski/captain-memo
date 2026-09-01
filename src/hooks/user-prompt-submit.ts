import { readStdinJson, writeStdout, workerFetch, logHookError, logWorkerFailure, resolveProjectId, isMainModule } from './shared.ts';
import { DEFAULT_HOOK_TIMEOUT_MS, ENV_HOOK_TIMEOUT_MS, DEFAULT_WORKER_PORT } from '../shared/paths.ts';
import type { EnvelopePayload } from '../shared/types.ts';
import { readTransition } from '../shared/worker-transition.ts';

interface UserPromptSubmitPayload {
  prompt?: string;
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
}

export interface UserPromptSubmitOptions {
  /** Native hook hosts retain the submitted prompt and treat hook stdout as
   *  additional context. Claude Code's legacy transform contract expects the
   *  original prompt echoed after the envelope. */
  emitOriginalPrompt?: boolean;
  /** Emit the structured additionalContext contract shared by the supported
   *  native hook hosts instead of Claude's prompt-transform stdout. */
  structuredContextJson?: boolean;
  /** Event name required inside the native CLI's structured hook output. */
  contextEventName?: 'UserPromptSubmit' | 'BeforeAgent';
}

export async function main(options: UserPromptSubmitOptions = {}): Promise<void> {
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

  // Fire-and-forget revival — but CONFIRM a real outage before the destructive
  // reclaim. A failed /inject/context does NOT mean the worker is dead: that
  // endpoint embeds the prompt to search, so a slow/flaky Voyage roundtrip makes
  // it time out while the worker is perfectly alive (and /health answers instantly
  // when the event loop is turning). Reclaiming on that single failure force-kills
  // a busy worker mid-embed → it restarts → the next prompt lands during startup →
  // reclaim again → thrash (field 2026-06-02: this cascade caused dozens of
  // restarts off one Voyage blip). So re-probe /health a couple of times first and
  // only reclaim if it stays unreachable — the same confirm-then-reclaim discipline
  // the watchdog uses. Quick probes (1.5s, 2 attempts): a live worker answers the
  // first one in ms, so the common case adds ~nothing; only a genuinely-down worker
  // pays the full confirm. On Windows restartWorker force-kills the port owner first
  // (IgnoreNew makes a bare start a no-op against a zombie). The heal lock keeps
  // concurrent prompts from stampeding. Opt out with CAPTAIN_MEMO_DISABLE_SELF_HEAL=1.
  // …and never against a worker that is BOOTING or restarting onto a new version: it left a breadcrumb
  // saying the outage is deliberate, and a reclaim there hard-kills a worker seconds from healthy (on
  // win32 racing the updater's own relauncher for the port). Short-circuits after !result.ok, so the
  // normal path never touches the filesystem. The breadcrumb's TTL bounds this: a relaunch that never
  // lands stops shielding the worker within 2 minutes and the usual heal takes over.
  const transition = result.ok ? null : readTransition();
  if (transition) {
    // Log the NON-action too. The /inject/context failure above is already in hook.log; without this
    // line the reader sees repeated failures and no recovery attempt, and goes hunting the heal lock
    // or a broken service manager. TTL-bounded, so this can log a handful of times at most.
    logHookError('UserPromptSubmit', new Error(`worker is ${transition.phase} — skipping the reclaim`));
  }
  if (!result.ok && process.env.CAPTAIN_MEMO_DISABLE_SELF_HEAL !== '1' && !transition) {
    try {
      const { acquireHealLock, releaseHealLock } = await import('../shared/worker-heal-lock.ts');
      if (acquireHealLock()) {
        try {
          const { probeHealthOnce, probeHealthyWithRetries } = await import('../shared/worker-health-probe.ts');
          const port = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
          const reachable = await probeHealthyWithRetries(() => probeHealthOnce(port, 1500), 2, 1000);
          if (!reachable) {
            const { getServiceManager } = await import('../services/service-manager/index.ts');
            const { restartWorker } = await import('../shared/worker-control.ts');
            await restartWorker(getServiceManager(), 'captain-memo-worker', { port });
          }
        } finally {
          releaseHealLock();
        }
      }
    } catch (err) {
      logHookError('UserPromptSubmit', err);
    }
  }

  if (result.ok && result.body && result.body.envelope) {
    if (options.structuredContextJson) {
      writeStdout(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: options.contextEventName ?? 'UserPromptSubmit',
          additionalContext: result.body.envelope,
        },
      }));
    } else {
      writeStdout(result.body.envelope);
      writeStdout('\n\n');
    }
  }
  if (options.emitOriginalPrompt !== false) writeStdout(prompt);
}

if (isMainModule(import.meta)) {
  try {
    await main();
  } catch (err) {
    logHookError('UserPromptSubmit', err);
    process.exit(0);
  }
}
