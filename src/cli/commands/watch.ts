// src/cli/commands/watch.ts
//
// `captain-memo watch` — DEPRECATED. Superseded by `captain-memo top`, the
// interactive TUI. Kept as a thin alias so muscle memory and old docs still
// work: it prints a one-line notice, then hands off to `top` with the same
// optional interval argument.
//
// The old implementation shelled out to the external `watch(1)` binary and
// reprinted a static frame; `top` is a real raw-mode TUI (sort/filter/drill)
// and needs no external dependency.

import { topCommand } from './top.ts';

export async function watchCommand(args: string[]): Promise<number> {
  if (!args.includes('-h') && !args.includes('--help')) {
    console.error('\x1b[2mcaptain-memo watch is deprecated — launching `captain-memo top`. '
      + 'Press ? in-app for help.\x1b[0m');
  }
  return topCommand(args);
}
