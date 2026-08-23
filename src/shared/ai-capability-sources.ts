// Auto-discovery of installed AI runtime plugins/extensions.
//
// Unlike memory discovery, these paths intentionally end in known JSON
// manifest names. The worker never stores those files verbatim: the capability
// parser projects a small, secret-free descriptor before anything reaches the
// corpus.

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface AiCapabilitySource {
  tool: string;
  glob: string;
}

/** Missing means the zero-config capability catalog is ON. Explicitly empty is
 * the opt-out, matching CAPTAIN_MEMO_WATCH_SKILLS. */
export function resolveCapabilityWatchSetting(value: string | undefined): string {
  return value ?? 'auto';
}

function claudeInstalledManifests(home: string): AiCapabilitySource[] {
  const inventory = join(home, '.claude', 'plugins', 'installed_plugins.json');
  if (!existsSync(inventory)) return [];
  try {
    const parsed = JSON.parse(readFileSync(inventory, 'utf8')) as {
      plugins?: Record<string, Array<{ installPath?: unknown; scope?: unknown }>>;
    };
    const out: AiCapabilitySource[] = [];
    for (const installs of Object.values(parsed.plugins ?? {})) {
      for (const install of installs) {
        // Project-scoped plugins must not be silently published by a global
        // captain. User/local installs are fleet-visible capabilities.
        if (install.scope === 'project' || typeof install.installPath !== 'string') continue;
        const manifest = join(install.installPath, '.claude-plugin', 'plugin.json');
        if (existsSync(manifest)) out.push({ tool: 'claude-code', glob: manifest });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function allCapabilitySources(home: string = homedir()): AiCapabilitySource[] {
  return [
    { tool: 'gemini', glob: join(home, '.gemini', 'extensions', '*', 'gemini-extension.json') },
    { tool: 'agy', glob: join(home, '.agents', 'plugins', '*', 'plugin.json') },
    { tool: 'codex', glob: join(home, '.codex', 'plugins', 'cache', '*', '*', '*', '.codex-plugin', 'plugin.json') },
    ...claudeInstalledManifests(home),
  ];
}

export function discoverCapabilityGlobs(home: string = homedir()): string[] {
  const seen = new Set<string>();
  const globs: string[] = [];
  for (const source of allCapabilitySources(home)) {
    // Keep wildcard roots even when currently empty: the watcher can observe a
    // newly-created manifest when the concrete parent already exists.
    const probe = source.glob.slice(0, source.glob.indexOf('*') >= 0 ? source.glob.indexOf('*') : source.glob.length);
    const base = probe.replace(/[\\/]$/, '');
    if (!existsSync(base) && !existsSync(source.glob)) continue;
    if (!seen.has(source.glob)) { seen.add(source.glob); globs.push(source.glob); }
  }
  return globs;
}
