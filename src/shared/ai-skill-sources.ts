// Auto-discovery of local Agent Skills across AI coding tools.
//
// Keep the boundary structural: every glob ends in SKILL.md. The adjacent
// directories also contain credentials, transcripts, databases, and caches;
// no broad directory or extension blocklist belongs here.

import { existsSync } from 'fs';
import { homedir } from 'os';
import { probeDir } from './ai-memory-sources.ts';
import { kimiCodeHomeDir } from './kimi-home.ts';
import { codexHomeGlobBase, isInCodexHome } from './codex-home.ts';

export interface AiSkillSource {
  /** Provenance recorded on the imported skill snapshot. */
  tool: string;
  /** Absolute glob ending in SKILL.md. */
  glob: string;
}

/** Missing means the zero-config fleet repository is ON. An explicitly empty
 * value remains the opt-out, so operators can still disable skill watching. */
export function resolveSkillWatchSetting(value: string | undefined): string {
  return value ?? 'auto';
}

/** Known user-level skill roots. Project roots and plugin caches stay opt-in:
 *  a global worker cannot infer which repositories/plugins the user wants to
 *  publish to every connected AI, and caches contain many duplicate versions. */
export function allSkillSources(home: string = homedir(), env: Record<string, string | undefined> = process.env): AiSkillSource[] {
  const codexHome = codexHomeGlobBase(home, env);
  return [
    { tool: 'claude-code', glob: `${home}/.claude/skills/*/SKILL.md` },
    { tool: 'codex', glob: `${home}/.agents/skills/*/SKILL.md` },
    // Legacy Codex location, still used by existing Captain Memo installs: $CODEX_HOME when set, else ~/.codex (the one skills dir codex reads).
    { tool: 'codex', glob: `${codexHome}/skills/*/SKILL.md` },
    { tool: 'codex', glob: `${codexHome}/skills/.system/*/SKILL.md` },
    { tool: 'gemini', glob: `${home}/.gemini/skills/*/SKILL.md` },
    { tool: 'cursor', glob: `${home}/.cursor/skills/*/SKILL.md` },
    { tool: 'opencode', glob: `${home}/.config/opencode/skills/*/SKILL.md` },
    { tool: 'vibe', glob: `${home}/.vibe/skills/*/SKILL.md` },
    { tool: 'kimi', glob: `${home}/.kimi/skills/*/SKILL.md` },
    { tool: 'kimi', glob: `${kimiCodeHomeDir(home, env)}/skills/*/SKILL.md` },   // kimi 2.x
  ];
}

/** Auto sources whose containing directory exists, deduped and cheap to probe. */
export function discoverSkillGlobs(home: string = homedir(), env: Record<string, string | undefined> = process.env): string[] {
  const seen = new Set<string>();
  for (const source of allSkillSources(home, env)) {
    if (existsSync(probeDir(source.glob))) seen.add(source.glob);
  }
  return [...seen];
}

/** Best-effort origin for an explicitly configured path outside auto roots. */
export function skillToolFromPath(path: string, env: Record<string, string | undefined> = process.env): string {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.includes('/.claude/')) return 'claude-code';
  if (normalized.includes('/.agents/skills/') || normalized.includes('/.codex/')) return 'codex';
  if (normalized.includes('/.gemini/')) return 'gemini';
  if (normalized.includes('/.cursor/')) return 'cursor';
  if (normalized.includes('/opencode/')) return 'opencode';
  if (normalized.includes('/.vibe/')) return 'vibe';
  if (normalized.includes('/.kimi/') || normalized.includes('/.kimi-code/')) return 'kimi';
  if (isInCodexHome(path, undefined, env)) return 'codex';   // a relocated $CODEX_HOME
  if (env.KIMI_CODE_HOME && normalized.startsWith(env.KIMI_CODE_HOME.replace(/\\/g, '/').replace(/\/+$/, '') + '/')) return 'kimi';   // a relocated kimi 2.x home
  return 'other';
}
