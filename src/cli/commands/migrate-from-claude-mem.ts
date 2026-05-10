import { existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { Database } from 'bun:sqlite';
import { MetaStore } from '../../worker/meta.ts';
import { Embedder } from '../../worker/embedder.ts';
import { embedderMaxTokens } from '../../shared/embedder-limits.ts';
import { VectorStore } from '../../worker/vector-store.ts';
import { runMigration } from '../../migration/runner.ts';
import { CLAUDE_MEM_DEFAULT_PATH } from '../../migration/claude-mem-schema.ts';
import {
  DATA_DIR,
  META_DB_PATH,
  VECTOR_DB_DIR,
  DEFAULT_VOYAGE_ENDPOINT,
} from '../../shared/paths.ts';
import { fmtBytes } from '../../shared/format.ts';
import { boldRed, dim as dimText, green, yellow } from '../../shared/ansi.ts';
import { printMiniBanner } from '../banner.ts';

async function discoverEmbeddingDim(
  endpoint: string,
  embedder: { embed: (texts: string[]) => Promise<number[][]> },
): Promise<number> {
  // 1. Explicit override wins (always honored).
  const envDim = process.env.CAPTAIN_MEMO_EMBEDDING_DIM;
  if (envDim) return Number(envDim);

  // 2. Probe the sidecar's /health (Captain Memo + Aelita convention).
  try {
    const healthUrl = endpoint.replace(/\/v1\/embeddings\/?$|\/embed\/?$/, '/health');
    if (healthUrl !== endpoint) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(healthUrl, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        const j = (await res.json()) as { dim?: number };
        if (typeof j.dim === 'number' && j.dim > 0) return j.dim;
      }
    }
  } catch { /* fall through */ }

  // 3. Real embedding probe — works for any provider (Voyage hosted has no
  //    /health, OpenAI doesn't either). Costs one tiny token but is
  //    authoritative: the dim we get back is the dim we'll write.
  try {
    const vecs = await embedder.embed(['ok']);
    if (vecs[0] && vecs[0].length > 0) return vecs[0].length;
  } catch { /* fall through */ }

  // 4. Last-resort default. Warn loudly — silently using a fallback dim is
  //    how a corrupted vector store sneaks in.
  console.error(
    `[migrate] Could not determine embedding dim from env, /health, or a probe ` +
    `embedding. Falling back to 2048 (voyage-4-nano open-weights native). ` +
    `If your embedder uses a different dim, set CAPTAIN_MEMO_EMBEDDING_DIM=<n> ` +
    `explicitly to avoid corruption.`,
  );
  return 2048;
}

// Portable across GNU/BSD/macOS (`du -sb` is GNU-only; `-sk` is POSIX).
function dirSize(path: string): number {
  if (!existsSync(path)) return 0;
  const r = spawnSync('du', ['-sk', path], { encoding: 'utf-8' });
  if (r.status !== 0) return 0;
  const m = r.stdout.match(/^(\d+)/);
  return m ? Number(m[1]) * 1024 : 0;
}

// Captain Memo corpus only — excludes the embedder venv + model weights, which
// dominate ~/.captain-memo/ but aren't memory storage.
function corpusSize(): number {
  const total = dirSize(DATA_DIR);
  const embedDir = join(DATA_DIR, 'embed');
  return Math.max(0, total - dirSize(embedDir));
}

function fmtDate(epochS: number): string {
  return new Date(epochS * 1000).toISOString().slice(0, 10);
}

interface SourceStats {
  dbSize: number;
  observations: number;
  summaries: number;
  userPrompts: number;
  pendingMessages: number;
  obsRange: string;
}

function gatherSourceStats(dbPath: string): SourceStats {
  const db = new Database(dbPath, { readonly: true });
  try {
    const count = (table: string): number =>
      ((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined)?.n ?? 0);
    // claude-mem stores created_at_epoch in milliseconds.
    const range = db.query(
      `SELECT MIN(created_at_epoch) AS lo, MAX(created_at_epoch) AS hi FROM observations`,
    ).get() as { lo: number; hi: number } | undefined;
    const obsRange = range && range.lo && range.hi
      ? `${fmtDate(Math.floor(range.lo / 1000))} → ${fmtDate(Math.floor(range.hi / 1000))}`
      : '(empty)';
    return {
      dbSize: statSync(dbPath).size,
      observations: count('observations'),
      summaries: count('session_summaries'),
      userPrompts: count('user_prompts'),
      pendingMessages: count('pending_messages'),
      obsRange,
    };
  } finally {
    db.close();
  }
}

interface TargetStats {
  dataDirSize: number;
  totalChunks: number;
  byChannel: Record<string, number>;
}

function gatherTargetStats(meta: MetaStore): TargetStats {
  const stats = meta.stats();
  return {
    dataDirSize: corpusSize(),
    totalChunks: stats.total_chunks,
    byChannel: stats.by_channel,
  };
}

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

  printMiniBanner();

  // Snapshot source state up-front so we can show before/after numbers.
  const sourceStats = gatherSourceStats(flags.dbPath);

  console.log(`Migrating from: ${flags.dbPath}`);
  console.log(`Project:        ${flags.projectId}`);
  console.log(`Dry-run:        ${flags.dryRun}`);
  console.log(`Original DB will be left intact (claude-mem stays installed).`);
  console.log('');

  // Make sure data dirs exist before opening DBs.
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(VECTOR_DB_DIR)) mkdirSync(VECTOR_DB_DIR, { recursive: true });

  const meta = new MetaStore(META_DB_PATH);
  // Migration runs a long sequential call train against the embedder. Per-
  // call latency varies wildly across hardware: on a CPU-only sidecar with a
  // 16-chunk document, a single embed batch can run >60 s. Default to 5 min
  // so a slow but progressing call doesn't get clipped by the embedder
  // client's retry budget (3 × 60 s would otherwise stack to run-killing).
  // Override with CAPTAIN_MEMO_VOYAGE_TIMEOUT_MS for hosted-API usage where
  // a much shorter ceiling is fine.
  const timeoutMs = Number(process.env.CAPTAIN_MEMO_VOYAGE_TIMEOUT_MS ?? 300_000);
  const apiFormat = process.env.CAPTAIN_MEMO_VOYAGE_API_FORMAT === 'aelita'
    ? 'aelita'
    : 'openai';
  const model = process.env.CAPTAIN_MEMO_VOYAGE_MODEL ?? 'voyage-4-nano';
  const embedderOpts: ConstructorParameters<typeof Embedder>[0] = {
    endpoint: process.env.CAPTAIN_MEMO_VOYAGE_ENDPOINT ?? DEFAULT_VOYAGE_ENDPOINT,
    model,
    timeoutMs,
    apiFormat,
    maxInputTokens: process.env.CAPTAIN_MEMO_EMBEDDER_MAX_TOKENS
      ? Number(process.env.CAPTAIN_MEMO_EMBEDDER_MAX_TOKENS)
      : embedderMaxTokens(model),
  };
  if (process.env.CAPTAIN_MEMO_VOYAGE_API_KEY) {
    embedderOpts.apiKey = process.env.CAPTAIN_MEMO_VOYAGE_API_KEY;
  }
  const embedder = new Embedder(embedderOpts);
  const dim = await discoverEmbeddingDim(embedderOpts.endpoint, embedder);
  console.log(`Embedding dim: ${dim}`);
  console.log('');

  // Pre-flight snapshot — so the user can watch the target grow against a
  // known baseline even before the final comparison block prints.
  const numFmt = (n: number): string => n.toLocaleString('en-US');
  const initialTarget = gatherTargetStats(meta);
  console.log(`Source: ${fmtBytes(sourceStats.dbSize)} · ${numFmt(sourceStats.observations)} obs · ${numFmt(sourceStats.summaries)} sums · ${numFmt(sourceStats.userPrompts)} prompts · ${sourceStats.obsRange}`);
  console.log(`Target: ${fmtBytes(initialTarget.dataDirSize)} corpus · ${numFmt(initialTarget.totalChunks)} chunks (starting state)`);
  console.log('');

  const vector = new VectorStore({
    dbPath: join(VECTOR_DB_DIR, 'embeddings.db'),
    dimension: dim,
  });
  const collectionName = `am_${flags.projectId}`;
  await vector.ensureCollection(collectionName);

  const start = Date.now();
  // TTY: clear-line + repaint on top. Pipe/file: pad-with-spaces so the same
  // approach works in plain output even though the spinner frame still appears
  // in each line.
  const isTTY = process.stdout.isTTY === true;
  const renderLine = isTTY
    ? (msg: string) => process.stdout.write(`\r\x1b[2K${msg}`)
    : (msg: string) => process.stdout.write(`\r${msg}                `);
  const runOpts: Parameters<typeof runMigration>[1] = {
    dryRun: flags.dryRun,
    onProgress: renderLine,
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
  const verdict = result.errors > 0 ? yellow('partial') : green('complete');
  const errLine = result.errors > 0
    ? `  errors:                ${boldRed(String(result.errors))}`
    : `  errors:                ${result.errors}`;
  console.log('');
  console.log(`Migration ${flags.dryRun ? 'preview' : verdict} in ${elapsed}s:`);
  console.log(`  observations migrated: ${result.observations_migrated}`);
  console.log(`  observations skipped:  ${result.observations_skipped}`);
  console.log(`  summaries migrated:    ${result.summaries_migrated}`);
  console.log(`  summaries skipped:     ${result.summaries_skipped}`);
  console.log(errLine);
  console.log('');

  // Side-by-side: claude-mem source DB vs Captain Memo data dir, after the run.
  // (Skipped on dry-run — the target dir wouldn't reflect what migration would
  //  produce, so the comparison would mislead.)
  if (!flags.dryRun) {
    const targetStats = gatherTargetStats(meta);
    printComparison(flags.dbPath, sourceStats, targetStats);
  } else {
    console.log(`Dry-run only — nothing written. Re-run without --dry-run to apply.`);
  }
  console.log(`Original ${flags.dbPath} was NOT modified or deleted.`);

  vector.close();
  meta.close();
  return result.errors > 0 ? 1 : 0;
}

function printComparison(
  sourceDbPath: string,
  source: SourceStats,
  target: TargetStats,
): void {
  const row = (label: string, value: string, rLabel = '', rValue = ''): string => {
    const left = `  ${label.padEnd(18)} ${value.padEnd(18)}`;
    const right = rLabel ? `${rLabel.padEnd(18)} ${rValue}` : '';
    return left + right;
  };

  const num = (n: number): string => n.toLocaleString('en-US');
  const channelLines = Object.entries(target.byChannel)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ch, n]) => `    ${ch.padEnd(16)} ${num(n)}`);

  console.log(`Source (claude-mem)                 Target (captain-memo)`);
  console.log(`────────────────────                ─────────────────────`);
  console.log(row('DB size:',         fmtBytes(source.dbSize),     'Corpus size:',   fmtBytes(target.dataDirSize)));
  console.log(row('Observations:',    num(source.observations),    'Total chunks:',  num(target.totalChunks)));
  console.log(row('Summaries:',       num(source.summaries)));
  console.log(row('User prompts:',    num(source.userPrompts)));
  console.log(row('Pending messages:',num(source.pendingMessages)));
  console.log(row('Date range:',      source.obsRange));
  if (channelLines.length > 0) {
    console.log('');
    console.log(`  By channel:`);
    for (const line of channelLines) console.log(line);
  }
  console.log('');
  console.log(dimText(`  Source path: ${sourceDbPath}`));
  console.log(dimText(`  Target path: ${DATA_DIR}/`));
  console.log('');
}
