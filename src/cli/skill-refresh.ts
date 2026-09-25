// src/cli/skill-refresh.ts — keep the injected copies of the portable captain-memo skill current.
//
// `captain-memo connect` copies skills/captain-memo/SKILL.md into each CLI's skills/rules directory ONCE.
// Nothing re-copied it afterwards: a `git pull` or a self-update rewrote the checkout, the other CLIs kept
// the snapshot from the day they were connected, and the "what tools do I have" text never learned a tool
// added later (topics on work claims, homework). SessionStart calls this on every Claude Code start —
// refresh-only, never create: a CLI that was never connected here gets no file.
import { existsSync, copyFileSync } from 'fs';
import { join } from 'path';

/** Home-relative destinations the cross-AI adapters write the skill to. Duplicated from cross-ai.ts on
 *  purpose and locked to it by a test that parses the adapter source, so a new adapter without a refresh
 *  entry fails the suite instead of freezing silently. */
export const MEMO_SKILL_RELPATHS: readonly string[] = [
  '.codex/skills/captain-memo/SKILL.md',
  '.gemini/skills/captain-memo/SKILL.md',                     // gemini AND agy share this one
  '.cursor/rules/captain-memo.md',
  '.config/opencode/skills/captain-memo/SKILL.md',
  '.vibe/skills/captain-memo/SKILL.md',
  '.kimi/skills/captain-memo/SKILL.md',
  '.config/Code/User/prompts/captain-memo.instructions.md',
  '.config/JetBrains/captain-memo.md',
];

/** The skill this install ships, or null. `base` is the running code's directory: src/cli (install-hooks
 *  mode) or plugin/dist (the hook bundle). A checkout has skills/ two levels up; a Claude Code plugin CACHE
 *  (GitHub marketplace: ~/.claude/plugins/cache/<m>/<p>/<ver>/dist) holds only plugin/, so the bundle also
 *  looks in plugin/portable/, a byte copy kept in step by build:plugin and a drift test. */
export function resolveMemoSkillSource(base: string = import.meta.dir): string | null {
  return [
    join(base, '..', '..', 'skills', 'captain-memo', 'SKILL.md'),
    join(base, '..', 'portable', 'captain-memo', 'SKILL.md'),
  ].find((p) => existsSync(p)) ?? null;
}

export interface RefreshDeps {
  exists?: (p: string) => boolean;
  copy?: (from: string, to: string) => void;
}

/** Overwrite every EXISTING copy with the current skill. Best-effort per destination; returns what was refreshed. */
export function refreshMemoSkills(source: string, home: string, deps: RefreshDeps = {}): string[] {
  const exists = deps.exists ?? existsSync;
  const copy = deps.copy ?? copyFileSync;
  if (!exists(source)) return [];                       // nothing to copy FROM (non-checkout install)
  const refreshed: string[] = [];
  for (const rel of MEMO_SKILL_RELPATHS) {
    const dest = join(home, ...rel.split('/'));
    if (!exists(dest)) continue;                        // that AI was never connected here — do not create
    try { copy(source, dest); refreshed.push(dest); } catch { /* best-effort, per destination */ }
  }
  return refreshed;
}
