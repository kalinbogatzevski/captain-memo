import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import {
  CLAUDE_MEM_DEFAULT_PATH,
  CLAUDE_MEM_TABLES,
} from '../../migration/claude-mem-schema.ts';

export async function inspectClaudeMemCommand(args: string[]): Promise<number> {
  let dbPath = CLAUDE_MEM_DEFAULT_PATH;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db' && args[i + 1]) {
      dbPath = args[++i] as string;
    }
  }

  if (!existsSync(dbPath)) {
    console.error(`claude-mem database not found at: ${dbPath}`);
    console.error('Pass --db <path> if it lives elsewhere.');
    return 1;
  }

  // Open read-only — guaranteed to never write or delete the source DB.
  const db = new Database(dbPath, { readonly: true });
  console.log(`claude-mem inspect — ${dbPath}`);
  console.log('---');

  const masterRows = db
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const presentTables = new Set(masterRows.map(r => r.name));

  let missing = 0;
  let tableErrors = 0;
  for (const expected of CLAUDE_MEM_TABLES) {
    const present = presentTables.has(expected) ? 'OK' : 'MISSING';
    if (!presentTables.has(expected)) missing++;
    let count = 0;
    if (presentTables.has(expected)) {
      try {
        const row = db
          .query(`SELECT COUNT(*) AS n FROM ${expected}`)
          .get() as { n: number };
        count = row.n;
      } catch (err) {
        // Table exists but querying fails (locked, corrupted). Don't lie
        // with exit 0 — count it as an error so callers (CI, doctor) react.
        tableErrors++;
        console.log(
          `${expected.padEnd(20)} present, count error: ${(err as Error).message}`,
        );
        continue;
      }
    }
    console.log(`${expected.padEnd(20)} ${present.padEnd(8)} rows=${count}`);
  }

  console.log('---');
  if (missing > 0) {
    console.log(
      `Warning: ${missing} expected table(s) missing — migration may need a schema bump.`,
    );
  } else if (tableErrors > 0) {
    console.log(
      `Warning: ${tableErrors} table(s) errored on count — DB may be locked or corrupted.`,
    );
  } else {
    console.log('All expected tables present. Safe to run migrate-from-claude-mem.');
  }
  db.close();
  return (missing > 0 || tableErrors > 0) ? 1 : 0;
}
