// Single shebang shim → routes to the correct hook handler based on
// argv[2] or $CLAUDE_HOOK_EVENT_NAME. Logs unhandled errors via logHookError
// so silent timeouts are debuggable after-the-fact.

import { logHookError } from './shared.ts';

const EVENTS: Record<string, string> = {
  UserPromptSubmit: '../hooks/user-prompt-submit.ts',
  SessionStart:     '../hooks/session-start.ts',
  PostToolUse:      '../hooks/post-tool-use.ts',
  Stop:             '../hooks/stop.ts',
};

async function main(): Promise<void> {
  const event =
    process.argv[2] ??
    process.env.CLAUDE_HOOK_EVENT_NAME ??
    process.env.CAPTAIN_MEMO_HOOK_EVENT;

  if (!event || !(event in EVENTS)) {
    process.exit(0);
  }

  const target = EVENTS[event]!;
  try {
    await import(target);
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
