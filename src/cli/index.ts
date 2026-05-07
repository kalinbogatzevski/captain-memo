import { statusCommand } from './commands/status.ts';
import { statsCommand } from './commands/stats.ts';
import { reindexCommand } from './commands/reindex.ts';
import { observationCommand } from './commands/observation.ts';
import { configCommand } from './commands/config.ts';

const HELP = `aelita-mcp — local memory layer for Claude Code

Usage:
  aelita-mcp <command> [args]

Commands:
  status       Check whether the worker is running and reachable
  stats        Print corpus statistics (chunk counts by channel)
  reindex      Re-embed corpus content (optionally scoped to a channel)
  observation  list|flush — manage observation queue (--limit N, --session ID)
  config       show — print effective config (env + defaults, secrets masked)
  help         Show this message

Examples:
  aelita-mcp status
  aelita-mcp stats
  aelita-mcp reindex --channel memory
  aelita-mcp reindex --force
  aelita-mcp observation list --limit 50
  aelita-mcp observation flush --session ses_abc
  aelita-mcp config show
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
