import type { Database } from 'bun:sqlite';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

const CREATE_SCHEMA_VERSIONS = `
CREATE TABLE IF NOT EXISTS schema_versions (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at_epoch INTEGER NOT NULL
);
`;

/**
 * Apply pending migrations to a SQLite database.
 *
 * Rules:
 *  - Ensures schema_versions table exists.
 *  - Skips already-applied versions.
 *  - Treats "duplicate column name" errors as idempotent-recovery (existing DBs
 *    that already have the column without a tracked migration get marked applied).
 *  - On unexpected errors, logs loudly but does NOT mark the version applied,
 *    so the next startup retries. Never throws — the store consumer will fail at
 *    INSERT/SELECT time if a column is genuinely missing.
 *  - Always applies in ascending version order regardless of array order.
 */
export function applyMigrations(db: Database, migrations: Migration[]): void {
  db.exec(CREATE_SCHEMA_VERSIONS);

  const applied = new Set<number>(
    (db.query('SELECT version FROM schema_versions').all() as Array<{ version: number }>)
      .map(r => r.version),
  );

  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  for (const migration of sorted) {
    if (applied.has(migration.version)) continue;

    let idempotent = false;
    try {
      migration.up(db);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err));
      if (/duplicate column/i.test(msg)) {
        // Column was added manually before this migration system existed.
        // Treat as already-applied so we record it and never try again.
        idempotent = true;
      } else {
        console.error(
          `[migrations] UNEXPECTED ERROR in migration ${migration.version} "${migration.name}": ${msg}`,
        );
        // Do NOT record — retry on next startup.
        continue;
      }
    }

    if (idempotent) {
      console.warn(
        `[migrations] migration ${migration.version} "${migration.name}" idempotent-recovery: column already existed, marking applied`,
      );
    }

    db.exec(
      `INSERT OR REPLACE INTO schema_versions (version, name, applied_at_epoch) VALUES (?, ?, ?)`,
      [migration.version, migration.name, Math.floor(Date.now() / 1000)],
    );
    applied.add(migration.version);
  }
}

export function getAppliedVersions(
  db: Database,
): Array<{ version: number; name: string; applied_at_epoch: number }> {
  // If the table doesn't exist yet, return empty (nothing applied).
  try {
    return db
      .query('SELECT version, name, applied_at_epoch FROM schema_versions ORDER BY version ASC')
      .all() as Array<{ version: number; name: string; applied_at_epoch: number }>;
  } catch {
    return [];
  }
}
