import { statusCommand } from './commands/status.ts';
import { statsCommand } from './commands/stats.ts';
import { reindexCommand } from './commands/reindex.ts';
import { vacuumCommand } from './commands/vacuum.ts';
import { upgradeCommand } from './commands/upgrade.ts';
import { observationCommand } from './commands/observation.ts';
import { configCommand } from './commands/config.ts';
import { installHooksCommand } from './commands/install-hooks.ts';
import { installCommand } from './commands/install.ts';
import { uninstallCommand } from './commands/uninstall.ts';
import { doctorCommand } from './commands/doctor.ts';
import { inspectClaudeMemCommand } from './commands/inspect-claude-mem.ts';
import { migrateFromClaudeMemCommand } from './commands/migrate-from-claude-mem.ts';
import { dreamCommand } from './commands/dream.ts';
import { dedupCommand } from './commands/dedup.ts';
import { watchCommand } from './commands/watch.ts';
import { topCommand } from './commands/top.ts';
import { workerWatchdogCommand } from './commands/worker-watchdog.ts';
import { printBanner } from './banner.ts';
import { VERSION } from '../shared/version.ts';

const HELP = `captain-memo — local memory layer for Claude Code

Usage:
  captain-memo <command> [args]

Commands:
  status       Check whether the worker is running and reachable (--json)
  stats        Print corpus statistics (chunk counts by channel) (--json)
  reindex      Re-embed corpus content (optionally scoped to a channel)
  vacuum       Reclaim disk after deletions/reindex (SQLite VACUUM; worker must be stopped)
  upgrade      Bring the corpus up to the current chunker shape (reindex + vacuum, end-to-end)
  observation  list|flush — manage observation queue (--limit N, --session ID)
  config       show — print effective config (env + defaults, secrets masked)
  install      Interactive wizard — installs everything (embedder, worker, plugin)
  uninstall    Clean removal of everything (--purge for data too)
  doctor       Health probe across embedder / worker / plugin
  install-hooks Register hooks manually (advanced — \`install\` does this for you)
  inspect-claude-mem  Print row counts of ~/.claude-mem/claude-mem.db (read-only).
  migrate-from-claude-mem  One-time migration of ~/.claude-mem/claude-mem.db (read-only)
  dream        Preview Local Dreaming clusters (read-only; --dry-run only in v1)
  dedup        Fold near-duplicate observations together (dry-run by default; --apply, --undo)
  top          Interactive live stats (htop-style: sort, filter, drill); press ? in-app
  watch        Deprecated alias for \`top\`
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
      exit = await statusCommand(args.slice(1));
      break;
    case 'stats':
      exit = await statsCommand(args.slice(1));
      break;
    case 'reindex':
      exit = await reindexCommand(args.slice(1));
      break;
    case 'vacuum':
      exit = await vacuumCommand(args.slice(1));
      break;
    case 'upgrade':
      exit = await upgradeCommand(args.slice(1));
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
    case 'migrate-from-claude-mem':
      exit = await migrateFromClaudeMemCommand(args.slice(1));
      break;
    case 'dream':
      exit = await dreamCommand(args.slice(1));
      break;
    case 'dedup':
      exit = await dedupCommand(args.slice(1));
      break;
    case 'top':
      exit = await topCommand(args.slice(1));
      break;
    case 'watch':
      exit = await watchCommand(args.slice(1));
      break;
    case 'worker-watchdog':
      // Internal: the captain-memo-watchdog Scheduled Task action. Probes /health
      // and reclaims a dead/zombie worker. Not advertised in HELP (not for humans).
      exit = await workerWatchdogCommand(args.slice(1));
      break;
    case 'help':
    case '--help':
    case '-h':
      printBanner(`v${VERSION}`);
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error(HELP);
      exit = 2;
  }
  process.exit(exit);
}

// Run directly when invoked as the entry point (e.g. `bun src/cli/index.ts …`,
// used by the Windows `captain-memo.cmd` shim). When imported by bin/captain-memo
// this stays false, so there is no double-invocation.
if (import.meta.main) {
  await main(process.argv.slice(2));
}
