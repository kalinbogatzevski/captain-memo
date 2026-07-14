// Auto-discovery of OTHER AI assistants' memory files.
//
// Captain Memo indexes markdown memory via CAPTAIN_MEMO_WATCH_MEMORY, which is a
// comma-separated list of globs. Hand-writing those globs is the kind of thing a
// tired person gets wrong, and it means Captain only ever sees Claude's memory
// even when Codex/Gemini/Cursor are installed right next to it.
//
// So: the sentinel `auto` in CAPTAIN_MEMO_WATCH_MEMORY expands to whichever of
// the globs below actually resolve on this machine. It composes — `auto,/my/notes/*.md`
// is a union, so the escape hatch costs nothing.
//
// ─── TWO INVARIANTS. Both are load-bearing; ai-memory-sources.test.ts enforces them. ───
//
// 1. EVERY GLOB CONTAINS AT LEAST ONE '*'.
//    Bun.Glob.scan() returns ZERO hits for a wildcard-free absolute path, even when
//    the file plainly exists (verified: `~/.claude/CLAUDE.md` → 0 hits,
//    `~/.claude/CLAUDE*.md` → 1 hit). A literal path here would silently index nothing.
//
// 2. EVERY GLOB ENDS IN .md OR .mdc.
//    This is the SECURITY boundary, and it is structural rather than a blocklist —
//    a blocklist is something you forget to update when a vendor adds a file.
//    These live in the very directories we glob, and must NEVER be indexed:
//      ~/.codex/auth.json, ~/.gemini/oauth_creds.json, ~/.gemini/google_accounts.json  (credentials)
//      ~/.codex/sessions/**.jsonl                                          (53 MB of transcripts here)
//      ~/.codex/*.sqlite, ~/.codex/history.jsonl                           (session state)
//    The extension gate makes all of them structurally unreachable. Do not add a
//    glob that ends in anything else, and do not add a bare-directory watch path.

import { existsSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';

export interface AiMemorySource {
  /** Provenance tag stored on the indexed doc — which assistant's memory this is. */
  tool: string;
  glob: string;
}

const H = homedir();

// Common places people keep repos. Probed, not configured: if none exist, the
// repo-level globs simply drop out. Users with repos elsewhere append their own
// glob — `CAPTAIN_MEMO_WATCH_MEMORY=auto,/srv/code/*/AGENTS.md` — which already works.
const REPO_ROOT_NAMES = ['projects', 'code', 'src', 'dev', 'repos', 'work', 'git'];

// Repo-level instruction files, relative to a code root, depth 1.
const REPO_PATTERNS: ReadonlyArray<readonly [tool: string, pattern: string]> = [
  ['agents', '*/AGENTS.md'],
  ['claude', '*/CLAUDE.md'],
  ['claude', '*/.claude/CLAUDE.md'],
  ['gemini', '*/GEMINI.md'],
  ['copilot', '*/.github/copilot-instructions.md'],
  ['cursor', '*/.cursor/rules/*.mdc'],
  ['cursor', '*/.cursor/rules/*.md'],
];

/** Every known memory location, whether or not it exists here. Flat table on purpose —
 *  a new assistant is a new row, not a plugin. */
export function allMemorySources(): AiMemorySource[] {
  const sources: AiMemorySource[] = [
    { tool: 'claude', glob: `${H}/.claude/CLAUDE*.md` },
    { tool: 'claude', glob: `${H}/.claude/memory/*.md` },
    { tool: 'claude', glob: `${H}/.claude/projects/*/memory/*.md` },
    // ~/.codex/memories/ exists but Codex currently persists memory in
    // memories_*.sqlite, not markdown — this glob is a harmless 0-hit today and
    // picks them up for free if Codex ever writes .md there.
    { tool: 'codex', glob: `${H}/.codex/memories/*.md` },
    { tool: 'codex', glob: `${H}/.codex/AGENTS*.md` },
    { tool: 'gemini', glob: `${H}/.gemini/GEMINI*.md` },
    { tool: 'cursor', glob: `${H}/.cursor/rules/*.md` },
    { tool: 'cursor', glob: `${H}/.cursor/rules/*.mdc` },
    { tool: 'opencode', glob: `${H}/.config/opencode/AGENTS*.md` },
  ];
  for (const name of REPO_ROOT_NAMES) {
    const root = join(H, name);
    for (const [tool, pattern] of REPO_PATTERNS) {
      sources.push({ tool, glob: `${root}/${pattern}` });
    }
  }
  return sources;
}

/**
 * The deepest directory that must exist for a glob to have any chance of matching.
 *
 * NOT simply "everything before the first '*'": when the wildcard sits in the
 * FILENAME (`~/.claude/CLAUDE*.md`) that prefix is `~/.claude/CLAUDE`, which is not
 * a path, so an existsSync on it is always false and the glob gets silently dropped
 * — which is exactly how ~/.claude/CLAUDE.md went missing the first time. Take the
 * containing directory unless the prefix already ends at a directory boundary.
 */
export function probeDir(glob: string): string {
  const prefix = glob.slice(0, glob.indexOf('*'));
  return prefix.endsWith('/') ? prefix : dirname(prefix);
}

/**
 * Globs whose containing directory actually exists on this machine, deduped.
 *
 * Probing the static prefix (not scanning) keeps this cheap enough to run at
 * worker boot: it's one existsSync per row, no filesystem walk.
 */
export function discoverMemoryGlobs(): string[] {
  const seen = new Set<string>();
  for (const s of allMemorySources()) {
    if (existsSync(probeDir(s.glob))) seen.add(s.glob);
  }
  return [...seen];
}

/** Which assistant a discovered file belongs to — stored as provenance on the doc. */
export function toolFromPath(p: string): string {
  for (const dir of ['codex', 'gemini', 'cursor', 'claude'] as const) {
    if (p.includes(`/.${dir}/`)) return dir;
  }
  if (p.includes('/opencode/')) return 'opencode';
  const b = basename(p);
  if (b === 'copilot-instructions.md') return 'copilot';
  if (b.endsWith('.mdc')) return 'cursor';
  if (b.startsWith('AGENTS')) return 'agents';
  if (b.startsWith('CLAUDE')) return 'claude';
  if (b.startsWith('GEMINI')) return 'gemini';
  return 'other';
}
