#!/usr/bin/env bun
// bin/captain-memo-hook — entry point spawned by Claude Code's hook engine.
// Always invokes the dispatcher's main() explicitly. When bun runs this
// file as the entry point, the imported dispatcher.ts is NOT the main
// module, so any `if (import.meta.main)` guard inside it would skip
// execution. Calling main() directly avoids that trap.
import { main } from '../src/hooks/dispatcher.ts';
import { logHookError } from '../src/hooks/shared.ts';

// Top-level await ensures the runtime waits for the dispatcher chain to
// complete before exiting. Without it, slow async work (e.g., a multi-second
// /stats fetch under worker contention) can race the natural end-of-script
// and the process exits before stdout is flushed.
try {
  await main();
} catch (err) {
  logHookError(process.argv[2] ?? 'unknown', err);
  process.exit(0);
}
