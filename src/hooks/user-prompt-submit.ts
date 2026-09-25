import { readStdinJson, writeStdout, workerFetch, logHookError, logWorkerFailure, resolveProjectId, isMainModule } from './shared.ts';
import { DEFAULT_HOOK_TIMEOUT_MS, ENV_HOOK_TIMEOUT_MS, DEFAULT_WORKER_PORT } from '../shared/paths.ts';
import type { EnvelopePayload } from '../shared/types.ts';
import { parseHomeworkPrompt, homeworkFiledLine, type HomeworkItem } from '../worker/homework.ts';
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
  /** The native CLI kills this process this many ms after spawning it and drops its stdout. */
  hostTimeoutMs?: number;
}

/** What performance.now() cannot see: the CLI's `$SHELL -lc` spawn (~40 ms), the stdout write and exit.
 *  ponytail: a fixed margin measured on Linux (bun 1.4.2, load 3-9); not measured on Windows. */
const HOST_EXIT_MARGIN_MS = 750;

/** How long homework capture may wait for the worker. 6 s under Claude Code (its hook timeout is 60 s);
 *  under a native CLI, whatever is left of the host's kill budget, so a slow worker still gets the
 *  "did not confirm" line to the model instead of the hook dying with nothing said. */
export function homeworkWaitMs(hostTimeoutMs: number | undefined, elapsedMs: number): number {
  if (hostTimeoutMs === undefined) return 6_000;
  return Math.max(0, Math.min(6_000, hostTimeoutMs - elapsedMs - HOST_EXIT_MARGIN_MS));
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

  // HOMEWORK CAPTURE: `idea: …` / `todo: …` / `later: …` typed mid-task is parked on the captain right here, before
  // the model spends a turn on it, and the model is told so in one line. The prompt still goes through (the user
  // may want a word back); recall is skipped — the prompt is not a question about the codebase.
  const homework = parseHomeworkPrompt(prompt);
  if (homework) {
    // Up to 6 s, not the 1.5 s envelope budget: the write queues behind the writer thread. Measured 2026-09-25
    // on a live threaded worker (505 writer RPCs): p50 12 ms, p95 0.9 s, 3.6% over 4.3 s, 2.8% over 6 s, 2.2%
    // stalled to the 10 s writer-RPC timeout. A native CLI kills the hook at 5 s, so there the wait is cut to
    // fit (homeworkWaitMs). A wait that runs out does not cancel the add: the writer still completes it.
    const filed = await workerFetch<{ item: HomeworkItem; open: number }>('/homework/add', { method: 'POST', body: { text: homework, by: payload.session_id ?? 'hook', project: resolveProjectId(payload.cwd) }, timeoutMs: homeworkWaitMs(options.hostTimeoutMs, performance.now()) });
    const line = filed.ok && filed.body ? homeworkFiledLine(filed.body.item) + ` (${filed.body.open} open)`
      : '📝 The worker did not confirm filing this as homework in time — it may still have landed: todo_list() shows; if it is not there, say "noted" and todo_add it yourself.';
    logWorkerFailure('UserPromptSubmit', '/homework/add', filed);
    if (options.structuredContextJson) writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: options.contextEventName ?? 'UserPromptSubmit', additionalContext: line } }));
    else { writeStdout(line); writeStdout('\n\n'); }
    if (options.emitOriginalPrompt !== false) writeStdout(prompt);
    return;
  }

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
