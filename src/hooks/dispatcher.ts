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
import { NATIVE_PROMPT_HOOK_TIMEOUT_S } from '../shared/paths.ts';
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
  // Native Codex uses the same lifecycle event names but not identical stdout
  // semantics. Installer-owned aliases keep the vendor behavior explicit while
  // reusing the same single-file hook bundle.
  CodexUserPromptSubmit: () => userPromptSubmit({ emitOriginalPrompt: false, structuredContextJson: true, hostTimeoutMs: NATIVE_PROMPT_HOOK_TIMEOUT_S * 1000 }),
  CodexPostToolUse: () => postToolUse({ originAgent: 'codex', source: 'hook:codex' }),
  CodexStop: () => stop({ emitJson: true }),
  GeminiBeforeAgent: () => userPromptSubmit({ emitOriginalPrompt: false, structuredContextJson: true, contextEventName: 'BeforeAgent', hostTimeoutMs: NATIVE_PROMPT_HOOK_TIMEOUT_S * 1000 }),
  GeminiAfterTool: () => postToolUse({ originAgent: 'gemini', source: 'hook:gemini' }),
  GeminiAfterAgent: () => stop({ emitJson: true }),
  // Kimi documents plain successful stdout as added context, but kimi-cli 1.52.0 only reads a
  // UserPromptSubmit result's block decision (soul/kimisoul.py), so this output does not reach
  // the model there yet. Kept human-readable for when it does.
  KimiUserPromptSubmit: () => userPromptSubmit({ emitOriginalPrompt: false, hostTimeoutMs: NATIVE_PROMPT_HOOK_TIMEOUT_S * 1000 }),
  KimiPostToolUse: () => postToolUse({ originAgent: 'kimi', source: 'hook:kimi' }),
  KimiStop: () => stop(),
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
