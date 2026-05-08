import { statusCommand } from './commands/status.ts';
import { statsCommand } from './commands/stats.ts';
import { reindexCommand } from './commands/reindex.ts';
import { observationCommand } from './commands/observation.ts';
import { configCommand } from './commands/config.ts';
import { installHooksCommand } from './commands/install-hooks.ts';
import { installCommand } from './commands/install.ts';
import { uninstallCommand } from './commands/uninstall.ts';
import { doctorCommand } from './commands/doctor.ts';
import { inspectClaudeMemCommand } from './commands/inspect-claude-mem.ts';

const HELP = `captain-memo — local memory layer for Claude Code

Usage:
  captain-memo <command> [args]

Commands:
  status       Check whether the worker is running and reachable
  stats        Print corpus statistics (chunk counts by channel)
  reindex      Re-embed corpus content (optionally scoped to a channel)
  observation  list|flush — manage observation queue (--limit N, --session ID)
  config       show — print effective config (env + defaults, secrets masked)
  install      Interactive wizard — installs everything (embedder, worker, plugin)
  uninstall    Clean removal of everything (--purge for data too)
  doctor       Health probe across embedder / worker / plugin
  install-hooks Register hooks manually (advanced — \`install\` does this for you)
  inspect-claude-mem  Print row counts of ~/.claude-mem/claude-mem.db (read-only).
  help         Show this message

Examples:
  captain-memo status
  captain-memo stats
  captain-memo reindex --channel memory
  captain-memo reindex --force
  captain-memo observation list --limit 50
  captain-memo observation flush --session ses_abc
  captain-memo config show
`;

export async function main(args: string[]): Promise<void> {
  const cmd = args[0] ?? 'help';
  let exit = 0;
  switch (cmd) {
    case 'status':
      exit = await statusCommand();
      break;
    case 'stats':
      exit = await statsCommand();
      break;
    case 'reindex':
      exit = await reindexCommand(args.slice(1));
      break;
    case 'observation':
      exit = await observationCommand(args.slice(1));
      break;
    case 'config':
      exit = await configCommand(args.slice(1));
      break;
    case 'install-hooks':
      exit = await installHooksCommand(args.slice(1));
      break;
    case 'install':
      exit = await installCommand(args.slice(1));
      break;
    case 'uninstall':
      exit = await uninstallCommand(args.slice(1));
      break;
    case 'doctor':
      exit = await doctorCommand(args.slice(1));
      break;
    case 'inspect-claude-mem':
      exit = await inspectClaudeMemCommand(args.slice(1));
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error(HELP);
      exit = 2;
  }
  process.exit(exit);
}
