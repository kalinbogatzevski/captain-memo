// src/cli/commands/watch.ts
//
// `captain-memo watch` — live-refresh wrapper around `captain-memo stats`.
//
// Removes the need for the user to remember the four-piece incantation:
//   watch -c -n 2 'FORCE_COLOR=1 captain-memo stats --width 140'
//
// Behind the scenes this command spawns `watch -c` with FORCE_COLOR=1 and
// the current terminal width baked in, so colors render and the wide
// two-column layout activates automatically.
//
// Why a wrapper instead of "auto-detect watch": from inside the child
// process there's no reliable signal that watch is the parent (watch
// strips its own env), so we can't make the bare `captain-memo stats`
// adapt. A purpose-built command is the honest answer.

import { spawnSync } from 'child_process';

const HELP = `captain-memo watch — live, colored, wide stats refresh

Usage:
  captain-memo watch [seconds]

Arguments:
  seconds   Refresh interval in seconds. Default 2.

Notes:
  - Requires the \`watch\` binary (procps-ng); pre-installed on most Linux
    distros and available via Homebrew on macOS.
  - Press Ctrl+C to exit.
  - The layout self-scales to the terminal width on every refresh — resize
    the terminal anytime and the next tick adapts automatically.
`;

export async function watchCommand(args: string[]): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return 0;
  }

  const intervalRaw = args[0] ?? '2';
  const interval = parseFloat(intervalRaw);
  if (!Number.isFinite(interval) || interval <= 0) {
    console.error(`captain-memo watch: interval must be a positive number; got "${intervalRaw}"`);
    return 2;
  }

  // We re-invoke captain-memo via the SAME script path that's running now —
  // avoids depending on $PATH having the binary visible (the user may run
  // from the project dir without having installed it globally).
  const self = process.argv.slice(0, 2).map(shellQuote).join(' ');

  // IMPORTANT: do NOT pin --width here. `watch` exports COLUMNS=<cols> to its
  // child on every refresh based on its current terminal size (verified via
  // `strings /usr/bin/watch` → `COLUMNS=%ld` format string). The renderer's
  // resolvePanelWidth() picks up that env var, so the layout self-scales
  // when the user resizes the terminal mid-session. Pinning --width here
  // would freeze the width at launch time and break that responsiveness —
  // the exact bug the user reported in v0.1.14.
  const inner = `FORCE_COLOR=1 ${self} stats`;

  // Run watch with -c (interpret ANSI), -n <seconds>, and the inner command.
  // stdio: inherit so watch fully takes over the terminal until Ctrl+C.
  const result = spawnSync(
    'watch',
    ['-c', '-n', String(interval), inner],
    { stdio: 'inherit' },
  );

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.error(`captain-memo watch: \`watch\` binary not found in PATH.`);
      console.error(`  Install procps-ng: \`apt install procps\` / \`brew install watch\`.`);
      return 127;
    }
    console.error(`captain-memo watch: spawn failed: ${err.message}`);
    return 1;
  }
  return result.status ?? 0;
}

/** Minimal POSIX-shell quoting — safe single-quote with embedded-quote escape.
 *  Conservative: if the string is alphanumeric/safe-punctuation only, return
 *  as-is for readability. */
function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./@:+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
