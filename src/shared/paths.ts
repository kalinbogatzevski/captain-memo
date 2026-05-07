import { homedir } from 'os';
import { join } from 'path';

export const DATA_DIR = process.env.AELITA_MCP_DATA_DIR ?? join(homedir(), '.aelita-mcp');

export const META_DB_PATH = join(DATA_DIR, 'meta.sqlite3');
export const QUEUE_DB_PATH = join(DATA_DIR, 'queue.db');
export const OBSERVATIONS_DB_PATH = join(DATA_DIR, 'observations.db');
export const PENDING_EMBED_DB_PATH = join(DATA_DIR, 'pending_embed.db');
export const VECTOR_DB_DIR = join(DATA_DIR, 'vector-db');
export const LOGS_DIR = join(DATA_DIR, 'logs');
export const ARCHIVE_DIR = join(DATA_DIR, 'archive');
export const CONFIG_PATH = join(DATA_DIR, 'config.json');

export const DEFAULT_WORKER_PORT = 39888;
export const DEFAULT_VOYAGE_ENDPOINT = 'http://localhost:8124/v1/embeddings';

// Plan-2 additions ─────────────────────────────────────────────────────

// Snapshot of "current best small/fast Claude" at 2026-05. Override via env
// when newer Haiku-class models ship — the worker doesn't care about the version,
// only that the configured model speaks the Anthropic Messages API.
export const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-6';

// Ordered fallback chain — each model is tried on `model_not_found` from the
// previous one. The first successful model is cached for the worker's lifetime.
// Override via AELITA_MCP_HAIKU_FALLBACKS (comma-separated list).
export const DEFAULT_HAIKU_FALLBACKS: string[] = ['claude-haiku-4-5'];

// Env-var names — keep all under AELITA_MCP_* except ANTHROPIC_API_KEY,
// which intentionally matches the Anthropic SDK convention.
export const ENV_ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY';
export const ENV_SUMMARIZER_PROVIDER = 'AELITA_MCP_SUMMARIZER_PROVIDER';
export const ENV_HAIKU_MODEL = 'AELITA_MCP_HAIKU_MODEL';
export const ENV_HAIKU_FALLBACKS = 'AELITA_MCP_HAIKU_FALLBACKS';
export const ENV_HOOK_BUDGET_TOKENS = 'AELITA_MCP_HOOK_BUDGET_TOKENS';
export const ENV_HOOK_TIMEOUT_MS = 'AELITA_MCP_HOOK_TIMEOUT_MS';
export const ENV_OBSERVATION_BATCH_SIZE = 'AELITA_MCP_OBSERVATION_BATCH_SIZE';
export const ENV_OBSERVATION_TICK_MS = 'AELITA_MCP_OBSERVATION_TICK_MS';

/** Summarizer transport providers. 'anthropic' = Anthropic SDK with API key
 *  (default); 'claude-code' = `claude -p` subprocess (Max plan auth, no key). */
export type SummarizerProvider = 'anthropic' | 'claude-code';
export const DEFAULT_SUMMARIZER_PROVIDER: SummarizerProvider = 'anthropic';

// Hard contracts from spec §5 — defaults if env not set.
export const DEFAULT_HOOK_TIMEOUT_MS = 250;
export const DEFAULT_STOP_DRAIN_BUDGET_MS = 5_000;
export const DEFAULT_HOOK_BUDGET_TOKENS = 4_000;
export const DEFAULT_OBSERVATION_BATCH_SIZE = 20;
export const DEFAULT_OBSERVATION_TICK_MS = 5_000;
