// Single shebang shim → routes to the correct hook handler based on
// argv[2] or $CLAUDE_HOOK_EVENT_NAME. Logs unhandled errors via logHookError
// so silent timeouts are debuggable after-the-fact.
//
// Handlers are STATICALLY imported, not dynamically imported by a variable
// specifier. This is load-bearing: `bun build` can only inline a dynamic
// import when its specifier is a string literal — `await import(someVar)` is
// left as a RUNTIME import. The committed single-file bundle has no sibling
// `../hooks/*.ts` to resolve against, so a variable import there fails
// `Cannot find module` and every hook silently no-ops (fail-open exit 0).
// Static imports force all five handlers into the bundle; dispatch then picks
// one by reference. (Regression history: commit 8295f08.)

import { logHookError } from './shared.ts';
import { main as userPromptSubmit } from './user-prompt-submit.ts';
import { main as sessionStart } from './session-start.ts';
import { main as preToolUse } from './pre-tool-use.ts';
import { main as postToolUse } from './post-tool-use.ts';
import { main as stop } from './stop.ts';
import { main as preCompact } from './pre-compact.ts';

const EVENTS: Record<string, () => Promise<void>> = {
  UserPromptSubmit: userPromptSubmit,
  SessionStart:     sessionStart,
  PreToolUse:       preToolUse,
  PostToolUse:      postToolUse,
  Stop:             stop,
  PreCompact:       preCompact,
};

export async function main(): Promise<void> {
  const event =
    process.argv[2] ??
    process.env.CLAUDE_HOOK_EVENT_NAME ??
    process.env.CAPTAIN_MEMO_HOOK_EVENT;

  if (!event || !(event in EVENTS)) {
    process.exit(0);
  }

  const handler = EVENTS[event]!;
  try {
    // Each handler exports `main` and runs only when invoked here — their own
    // `if (import.meta.main)` self-run guard is FALSE in the bundle (only the
    // bin entry is the main module), so importing them does not double-run.
    await handler();
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
