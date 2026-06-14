// src/shared/edition.ts — build EDITION, DERIVED (no per-branch constant), byte-identical on both lines.
//
// 'federation' when the private federation worker tree is present in THIS checkout, else 'oss'. This is a
// PATH-STRING existence check, NOT a federation import — so the file is OSS-safe and the moat-guard (which
// fails only when the src/worker/federation/ DIRECTORY exists on master, not when a string names it) stays
// green. Surfaced in /stats + the SessionStart banner so a captain shows which build it runs.
import { existsSync } from 'fs';
import { join } from 'path';

export type Edition = 'federation' | 'oss';

/** 'federation' iff a `worker/federation` tree exists one level up from `baseDir` (i.e. src/shared → src/worker/
 *  federation), else 'oss'. Pure over the fs, so it's unit-testable with a fabricated dir — no branch dependence. */
export function detectEdition(baseDir: string): Edition {
  return existsSync(join(baseDir, '..', 'worker', 'federation')) ? 'federation' : 'oss';
}

export const EDITION: Edition = detectEdition(import.meta.dir);
