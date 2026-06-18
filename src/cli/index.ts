import { statusCommand } from './commands/status.ts';
import { statsCommand } from './commands/stats.ts';
import { reindexCommand } from './commands/reindex.ts';
import { vacuumCommand } from './commands/vacuum.ts';
import { upgradeCommand } from './commands/upgrade.ts';
import { observationCommand } from './commands/observation.ts';
import { restoreCommand } from './commands/restore.ts';
import { configCommand } from './commands/config.ts';
import { installHooksCommand } from './commands/install-hooks.ts';
import { installCommand } from './commands/install.ts';
import { connectCommand } from './commands/connect.ts';
import { uninstallCommand } from './commands/uninstall.ts';
import { doctorCommand } from './commands/doctor.ts';
import { inspectClaudeMemCommand } from './commands/inspect-claude-mem.ts';
import { migrateFromClaudeMemCommand } from './commands/migrate-from-claude-mem.ts';
import { dreamCommand } from './commands/dream.ts';
import { dedupCommand } from './commands/dedup.ts';
import { rememberCommand } from './commands/remember.ts';
import { watchCommand } from './commands/watch.ts';
import { topCommand } from './commands/top.ts';
import { workerWatchdogCommand } from './commands/worker-watchdog.ts';
import { restartCommand } from './commands/restart.ts';
import { evalCommand } from './commands/eval.ts';
import { printBanner } from './banner.ts';
import { VERSION } from '../shared/version.ts';

const HELP = `captain-memo — local memory layer for Claude Code

Usage:
  captain-memo <command> [args]

Commands:
  status       Check whether the worker is running and reachable (--json)
  stats        Print corpus statistics (chunk counts by channel) (--json)
  reindex      Re-embed corpus content (optionally scoped to a channel)
  remember     Persist a curated memory entry (--type, body via --body/--file/stdin)
  vacuum       Reclaim disk after deletions/reindex (SQLite VACUUM; worker must be stopped)
  upgrade      Bring the corpus up to the current chunker shape (reindex + vacuum, end-to-end)
  observation  list|sunk|flush — manage observations (sunk: list dormant/archived; --archived)
  restore      Re-surface a sunk (dormant/archived) observation: restore <id>
  config       show — print effective config (env + defaults, secrets masked)
  install      Interactive wizard — installs everything (embedder, worker, plugin)
  connect      Wire other AI tools (Codex, Gemini, Cursor) to the shared worker (--list)
  uninstall    Clean removal of everything (--purge for data too)
  doctor       Health probe across embedder / worker / plugin
  restart      Restart the local worker (reload config / recover). --force to hard-stop
  install-hooks Register hooks manually (advanced — \`install\` does this for you)
  inspect-claude-mem  Print row counts of ~/.claude-mem/claude-mem.db (read-only).
  migrate-from-claude-mem  One-time migration of ~/.claude-mem/claude-mem.db (read-only)
  dream        Preview Local Dreaming clusters (read-only; --dry-run only in v1)
  dedup        Fold near-duplicate observations together (dry-run by default; --apply, --undo)
  eval         Run the search-quality eval harness (seed | run --profile=legacy,v2)
  top          Interactive live stats (htop-style: sort, filter, drill); press ? in-app
  watch        Deprecated alias for \`top\`
  help         Show this message

Examples:
  captain-memo status
  captain-memo stats
  captain-memo reindex --channel memory
  captain-memo reindex --force
  captain-memo remember --type decision --body "We standardized on Bun"
  echo "long note" | captain-memo remember --type reference --name "API notes"
  captain-memo observation list --limit 50
  captain-memo observation flush --session ses_abc
  captain-memo config show
`;

/** Turn an uncaught command error into an actionable message. A dead/unreachable
 *  worker is the common case for recovery commands (restore, stats, top…) — surface
 *  the start hint instead of a raw stack trace. Returns the process exit code. */
function reportCliError(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ECONNREFUSED|Unable to connect|Connection refused|fetch failed|failed to connect/i.test(msg)) {
    console.error('captain-memo worker is not reachable.');
    console.error('  Start it with:  bun run worker:start   (or `captain-memo install` to set it up)');
    console.error('  Check status:   captain-memo status');
    return 1;
  }
  console.error(msg);
  return 1;
}

export async function main(args: string[]): Promise<void> {
  const cmd = args[0] ?? 'help';
  let exit = 0;
  try {
  switch (cmd) {
    case 'status':
      exit = await statusCommand(args.slice(1));
      break;
    case 'restart':
      exit = await restartCommand(args.slice(1));
      break;
    case 'stats':
      exit = await statsCommand(args.slice(1));
      break;
    case 'reindex':
      exit = await reindexCommand(args.slice(1));
      break;
    case 'remember':
      exit = await rememberCommand(args.slice(1));
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
    case 'restore':
      exit = await restoreCommand(args.slice(1));
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
    case 'connect':
      exit = await connectCommand(args.slice(1));
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
    case 'eval':
      exit = await evalCommand(args.slice(1));
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
  } catch (err) {
    exit = reportCliError(err);
  }
  process.exit(exit);
}

// Run directly when invoked as the entry point (e.g. `bun src/cli/index.ts …`,
// used by the Windows `captain-memo.cmd` shim). When imported by bin/captain-memo
// this stays false, so there is no double-invocation.
if (import.meta.main) {
  await main(process.argv.slice(2));
}
