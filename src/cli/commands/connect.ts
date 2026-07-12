// captain-memo connect — detect installed MCP-speaking AI coding tools (Codex,
// Gemini CLI, Cursor, opencode, Mistral Vibe, VS Code, JetBrains) and wire each
// to the SAME captain-memo worker so they all share one local memory corpus.
//
//   captain-memo connect            detect + wire every installed tool, print a report
//   captain-memo connect --list     just show which tools are detected (no changes)
//   captain-memo connect <tool>     wire only that tool (see ADAPTERS in cross-ai.ts)
//
// The actual per-tool logic lives in src/cli/cross-ai.ts (testable adapter layer).
// Claude Code is wired by the plugin install (`captain-memo install`), not here —
// it's listed in --list as already-wired, never duplicated.

import { join, resolve } from 'path';
import { existsSync } from 'fs';
import {
  connectCrossAi,
  detectCrossAi,
  printConnectReport,
  ADAPTERS,
  OPENCODE_LOCAL_PROVIDER_KEYS,
} from '../cross-ai.ts';

// Pull `--local-provider <key>` (or `--local-provider=<key>`) out of argv, consuming its VALUE so the value is
// never mistaken for a positional tool name. opencode-only: selects the local runtime to configure.
function extractLocalProvider(args: string[]): { localProvider?: string; rest: string[] } {
  const rest: string[] = [];
  let localProvider: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--local-provider') { localProvider = args[i + 1]; i++; continue; }
    if (a.startsWith('--local-provider=')) { localProvider = a.slice('--local-provider='.length); continue; }
    rest.push(a);
  }
  return localProvider !== undefined ? { localProvider, rest } : { rest };
}

// Same anchor install.ts uses — the captain-memo repo/plugin root.
const REPO_ROOT = resolve(import.meta.dir, '../../..');

function header(s: string): void { console.log(`\n\x1b[1;36m${s}\x1b[0m\n${'─'.repeat(s.length)}`); }
function info(s: string): void { console.log(`  ${s}`); }
function ok(s: string): void { console.log(`  \x1b[32m✓\x1b[0m ${s}`); }
function warn(s: string): void { console.log(`  \x1b[33m!\x1b[0m ${s}`); }

const KNOWN_TOOLS = ADAPTERS.map((a) => a.id);

const HELP = `Usage: captain-memo connect [<tool>] [--list] [--local-provider <ollama|vllm|lmstudio>]

Detect installed AI coding tools and wire each to the shared captain-memo worker
(register the MCP server + install the portable skill) so they all share ONE
local memory corpus.

  captain-memo connect            wire every installed tool
  captain-memo connect --list     just show which tools are detected (no changes)
  captain-memo connect <tool>     wire only that tool (${KNOWN_TOOLS.join(' | ')})

opencode only: --local-provider <${OPENCODE_LOCAL_PROVIDER_KEYS.join('|')}> selects the LOCAL
runtime to configure in opencode.json (default ollama). The OpenRouter gateway is always written.

Claude Code is wired by \`captain-memo install\` (the plugin), not here.
Re-running is safe (idempotent).`;

export async function connectCommand(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return 0;
  }

  // opencode-only: which local runtime to configure. Extract it (consuming its value so it is not mistaken for a
  // tool name) and validate before any work. `rest` is argv with the flag + value removed.
  const { localProvider, rest } = extractLocalProvider(args);
  if (localProvider !== undefined && !OPENCODE_LOCAL_PROVIDER_KEYS.includes(localProvider)) {
    warn(`unknown --local-provider "${localProvider}" (expected: ${OPENCODE_LOCAL_PROVIDER_KEYS.join(' | ')})`);
    return 1;
  }

  // The shared bits every adapter needs: the stdio MCP server argv and the
  // portable skill source. Built from REPO_ROOT exactly like install.ts.
  const mcpServer = join(REPO_ROOT, 'plugin/dist/mcp-server.js');
  const mcpCommand = ['bun', mcpServer];
  const skillSource = join(REPO_ROOT, 'skills/captain-memo/SKILL.md');

  // --list: detect-only, no changes.
  if (rest.includes('--list')) {
    header('AI tools that can share captain-memo');
    for (const row of detectCrossAi()) {
      const mark = row.detected ? '\x1b[32m✓\x1b[0m' : '\x1b[2m·\x1b[0m';
      const note = row.note ? ` \x1b[2m(${row.note})\x1b[0m` : '';
      console.log(`  ${mark} ${row.label.padEnd(14)} ${row.detected ? 'detected' : 'not found'}${note}`);
    }
    console.log();
    info('Run `captain-memo connect` to wire the detected tools, or');
    info('`captain-memo connect <tool>` to wire just one.');
    return 0;
  }

  // Warn (don't fail) if the artifacts the tools will launch/copy are missing —
  // the registration still goes through, it just won't work until they exist.
  if (!existsSync(mcpServer)) {
    warn(`MCP server not found at ${mcpServer} — tools will be registered but the`);
    info('server won\'t launch until you build the plugin (run `captain-memo install`).');
  }
  if (!existsSync(skillSource)) {
    warn(`skill source not found at ${skillSource} — skill copy will be skipped.`);
  }

  // A positional (non-flag) arg = wire just that tool.
  const only = rest.filter((a) => !a.startsWith('-'));
  if (only.length > 0) {
    const unknown = only.filter((t) => !KNOWN_TOOLS.includes(t));
    if (unknown.length > 0) {
      warn(`unknown tool(s): ${unknown.join(', ')} (expected: ${KNOWN_TOOLS.join(' | ')})`);
      return 1;
    }
    header(`Wiring ${only.join(', ')} to the shared worker`);
    const results = connectCrossAi({ only, mcpCommand, skillSource, ...(localProvider ? { localProvider } : {}) });
    printConnectReport(results);
    // Fail only if EVERY requested tool's MCP registration failed.
    return results.every((r) => r.mcp === 'failed') ? 1 : 0;
  }

  // No tool named: detect + wire all installed tools.
  header('Wiring installed AI tools to the shared worker');
  const results = connectCrossAi({ mcpCommand, skillSource, ...(localProvider ? { localProvider } : {}) });
  printConnectReport(results);
  if (results.length > 0) {
    console.log();
    ok('Done. Restart any open sessions in those tools so they pick up the MCP server.');
  }
  return 0;
}
