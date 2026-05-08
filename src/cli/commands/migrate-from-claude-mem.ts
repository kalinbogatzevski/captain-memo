import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { MetaStore } from '../../worker/meta.ts';
import { Embedder } from '../../worker/embedder.ts';
import { VectorStore } from '../../worker/vector-store.ts';
import { runMigration } from '../../migration/runner.ts';
import { CLAUDE_MEM_DEFAULT_PATH } from '../../migration/claude-mem-schema.ts';
import {
  DATA_DIR,
  META_DB_PATH,
  VECTOR_DB_DIR,
  DEFAULT_VOYAGE_ENDPOINT,
} from '../../shared/paths.ts';

interface CliFlags {
  dryRun: boolean;
  limit: number | undefined;
  fromId: number | undefined;
  keepOriginal: boolean;     // always true; documented for clarity
  projectId: string;
  dbPath: string;
}

function parseFlags(args: string[]): CliFlags {
  const flags: CliFlags = {
    dryRun: false,
    limit: undefined,
    fromId: undefined,
    keepOriginal: true,
    projectId: process.env.CAPTAIN_MEMO_PROJECT_ID ?? 'default',
    dbPath: CLAUDE_MEM_DEFAULT_PATH,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--limit' && args[i + 1]) flags.limit = Number(args[++i]);
    else if (a === '--from-id' && args[i + 1]) flags.fromId = Number(args[++i]);
    else if (a === '--project' && args[i + 1]) flags.projectId = args[++i] as string;
    else if (a === '--db' && args[i + 1]) flags.dbPath = args[++i] as string;
    else if (a === '--keep-original') flags.keepOriginal = true; // explicit no-op
    else {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return flags;
}

export async function migrateFromClaudeMemCommand(args: string[]): Promise<number> {
  const flags = parseFlags(args);

  if (!existsSync(flags.dbPath)) {
    console.error(`claude-mem database not found at: ${flags.dbPath}`);
    return 1;
  }

  console.log(`Migrating from: ${flags.dbPath}`);
  console.log(`Project:        ${flags.projectId}`);
  console.log(`Dry-run:        ${flags.dryRun}`);
  console.log(`Original DB will be left intact (claude-mem stays installed).`);
  console.log('');

  // Make sure data dirs exist before opening DBs.
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(VECTOR_DB_DIR)) mkdirSync(VECTOR_DB_DIR, { recursive: true });

  const meta = new MetaStore(META_DB_PATH);
  const embedderOpts: ConstructorParameters<typeof Embedder>[0] = {
    endpoint: process.env.CAPTAIN_MEMO_VOYAGE_ENDPOINT ?? DEFAULT_VOYAGE_ENDPOINT,
    model: process.env.CAPTAIN_MEMO_VOYAGE_MODEL ?? 'voyage-4-nano',
  };
  if (process.env.CAPTAIN_MEMO_VOYAGE_API_KEY) {
    embedderOpts.apiKey = process.env.CAPTAIN_MEMO_VOYAGE_API_KEY;
  }
  const embedder = new Embedder(embedderOpts);
  const vector = new VectorStore({
    dbPath: join(VECTOR_DB_DIR, 'embeddings.db'),
    dimension: 1024,
  });
  const collectionName = `am_${flags.projectId}`;
  await vector.ensureCollection(collectionName);

  const start = Date.now();
  const runOpts: Parameters<typeof runMigration>[1] = {
    dryRun: flags.dryRun,
    onProgress: (msg) => process.stdout.write(`\r${msg}        `),
  };
  if (flags.limit !== undefined) runOpts.limit = flags.limit;
  if (flags.fromId !== undefined) runOpts.fromId = flags.fromId;

  const result = await runMigration(
    {
      meta,
      embedder: { embed: (texts) => embedder.embed(texts) },
      vector,
      collectionName,
      projectId: flags.projectId,
      sourceDbPath: flags.dbPath,
    },
    runOpts,
  );
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('');
  console.log(`Migration ${flags.dryRun ? 'preview' : 'complete'} in ${elapsed}s:`);
  console.log(`  observations migrated: ${result.observations_migrated}`);
  console.log(`  observations skipped:  ${result.observations_skipped}`);
  console.log(`  summaries migrated:    ${result.summaries_migrated}`);
  console.log(`  summaries skipped:     ${result.summaries_skipped}`);
  console.log(`  errors:                ${result.errors}`);
  console.log('');
  if (flags.dryRun) {
    console.log(`Dry-run only — nothing written. Re-run without --dry-run to apply.`);
  }
  console.log(`Original ${flags.dbPath} was NOT modified or deleted.`);

  vector.close();
  meta.close();
  return result.errors > 0 ? 1 : 0;
}
