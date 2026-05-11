// Single shebang shim → routes to the correct hook handler based on
// argv[2] or $CLAUDE_HOOK_EVENT_NAME. Logs unhandled errors via logHookError
// so silent timeouts are debuggable after-the-fact.

import { logHookError } from './shared.ts';

const EVENTS: Record<string, string> = {
  UserPromptSubmit: '../hooks/user-prompt-submit.ts',
  SessionStart:     '../hooks/session-start.ts',
  PostToolUse:      '../hooks/post-tool-use.ts',
  Stop:             '../hooks/stop.ts',
  PreCompact:       '../hooks/pre-compact.ts',
};

export async function main(): Promise<void> {
  const event =
    process.argv[2] ??
    process.env.CLAUDE_HOOK_EVENT_NAME ??
    process.env.CAPTAIN_MEMO_HOOK_EVENT;

  if (!event || !(event in EVENTS)) {
    process.exit(0);
  }

  const target = EVENTS[event]!;
  try {
    // Dynamic import returns the module's exported names; call its main()
    // explicitly. The handler files no longer rely on `import.meta.main`
    // (which is FALSE here because the dispatcher is the actual entry, not
    // the handler) — they export `main` and we invoke it.
    const mod = await import(target) as { main?: () => Promise<void> };
    if (typeof mod.main === 'function') {
      await mod.main();
    } else {
      logHookError(event, new Error(`hook handler ${target} has no exported main()`));
    }
  } catch (err) {
    logHookError(event, err);
    process.exit(0);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    logHookError(process.argv[2] ?? 'unknown', err);
    process.exit(0);
  });
}
