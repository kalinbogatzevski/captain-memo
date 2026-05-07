import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';

export const AELITA_HOOK_MARKER = 'aelita-mcp-hook-managed';

const EVENTS = ['UserPromptSubmit', 'SessionStart', 'PostToolUse', 'Stop'] as const;
type EventName = typeof EVENTS[number];

interface HookCommandEntry {
  type: 'command';
  command: string;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommandEntry[];
}

interface ClaudeSettings {
  hooks?: Partial<Record<EventName, HookGroup[]>>;
  [other: string]: unknown;
}

export interface ApplyHookInstallOptions {
  settingsPath: string;
  hookCommand: string;
}

export interface ApplyHookInstallResult {
  events_added: number;
  events_already_present: number;
  warnings: string[];
}

function isOurEntry(entry: HookCommandEntry): boolean {
  return typeof entry.command === 'string' && entry.command.includes(AELITA_HOOK_MARKER);
}

function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettings(path: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2));
}

export function applyHookInstall(opts: ApplyHookInstallOptions): ApplyHookInstallResult {
  const { settingsPath, hookCommand } = opts;
  const settings = readSettings(settingsPath);
  if (!settings.hooks) settings.hooks = {};
  let events_added = 0;
  let events_already_present = 0;
  const warnings: string[] = [];

  for (const event of EVENTS) {
    const groups = settings.hooks[event] ?? [];
    let existing: HookCommandEntry | null = null;
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        if (isOurEntry(h)) { existing = h; break; }
      }
      if (existing) break;
    }

    if (existing) {
      if (!existing.command.startsWith(hookCommand)) {
        warnings.push(`${event}: marker present but command differs (${existing.command}); leaving untouched`);
      }
      events_already_present++;
      settings.hooks[event] = groups;
      continue;
    }

    const newEntry: HookCommandEntry = {
      type: 'command',
      command: `${hookCommand} ${event} #${AELITA_HOOK_MARKER}`,
    };
    groups.push({ hooks: [newEntry] });
    settings.hooks[event] = groups;
    events_added++;
  }

  writeSettings(settingsPath, settings);
  return { events_added, events_already_present, warnings };
}

export async function installHooksCommand(args: string[]): Promise<number> {
  let scope: 'user' | 'project' = 'user';
  let cwd = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project') scope = 'project';
    if (args[i] === '--cwd' && args[i + 1]) { cwd = resolve(args[i + 1]!); i++; }
  }

  const settingsPath = scope === 'project'
    ? join(cwd, '.claude', 'settings.json')
    : join(homedir(), '.claude', 'settings.json');

  const hookCommand = resolve(import.meta.dir, '../../../bin/aelita-mcp-hook');

  console.log(`Installing hooks to: ${settingsPath}`);
  console.log(`Hook command:        ${hookCommand}`);

  const result = applyHookInstall({ settingsPath, hookCommand });

  console.log(`events_added:        ${result.events_added}`);
  console.log(`events_already:      ${result.events_already_present}`);
  if (result.warnings.length > 0) {
    console.warn('\nWarnings:');
    for (const w of result.warnings) console.warn(`  - ${w}`);
  }
  return 0;
}
