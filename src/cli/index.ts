import { statusCommand } from './commands/status.ts';
import { statsCommand } from './commands/stats.ts';

const HELP = `aelita-mcp — local memory layer for Claude Code

Usage:
  aelita-mcp <command> [args]

Commands:
  status       Check whether the worker is running and reachable
  stats        Print corpus statistics (chunk counts by channel)
  help         Show this message

Examples:
  aelita-mcp status
  aelita-mcp stats
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
