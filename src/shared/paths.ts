import { homedir } from 'os';
import { join } from 'path';

export const DATA_DIR = process.env.CAPTAIN_MEMO_DATA_DIR ?? join(homedir(), '.captain-memo');

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

// Snapshot model name — what the summarizer asks the configured provider for.
// At time of writing (2026-05) this is a small/fast Anthropic Haiku, but the
// summarizer is provider-agnostic: set this to whatever model your endpoint
// serves (e.g. `gpt-4o-mini`, `qwen2.5:14b`, `claude-haiku-4-7`, etc.).
export const DEFAULT_SUMMARIZER_MODEL = 'claude-haiku-4-6';

// Ordered fallback chain — each model is tried on `model_not_found` from the
// previous one. The first successful model is cached for the worker's lifetime.
// Override via CAPTAIN_MEMO_SUMMARIZER_FALLBACKS (comma-separated list).
export const DEFAULT_SUMMARIZER_FALLBACKS: string[] = ['claude-haiku-4-5'];

// Env-var names — keep all under CAPTAIN_MEMO_* except ANTHROPIC_API_KEY,
// which intentionally matches the Anthropic SDK convention.
export const ENV_ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY';
export const ENV_SUMMARIZER_PROVIDER = 'CAPTAIN_MEMO_SUMMARIZER_PROVIDER';
export const ENV_SUMMARIZER_MODEL = 'CAPTAIN_MEMO_SUMMARIZER_MODEL';
export const ENV_SUMMARIZER_FALLBACKS = 'CAPTAIN_MEMO_SUMMARIZER_FALLBACKS';
export const ENV_HOOK_BUDGET_TOKENS = 'CAPTAIN_MEMO_HOOK_BUDGET_TOKENS';
export const ENV_HOOK_TIMEOUT_MS = 'CAPTAIN_MEMO_HOOK_TIMEOUT_MS';
export const ENV_OBSERVATION_BATCH_SIZE = 'CAPTAIN_MEMO_OBSERVATION_BATCH_SIZE';
export const ENV_OBSERVATION_TICK_MS = 'CAPTAIN_MEMO_OBSERVATION_TICK_MS';

/** Summarizer transport providers.
 *  - 'anthropic'         (default) — Anthropic SDK + ANTHROPIC_API_KEY
 *  - 'claude-code'       — `claude -p` subprocess; uses your Claude Code Max/Pro plan, no API key
 *  - 'openai-compatible' — POST /v1/chat/completions to CAPTAIN_MEMO_OPENAI_ENDPOINT;
 *                          works with Ollama, LM Studio, vLLM, llama.cpp, OpenAI,
 *                          OpenRouter, Together, Groq, DeepSeek, Mistral, etc. */
export type SummarizerProvider = 'anthropic' | 'claude-code' | 'openai-compatible';
export const DEFAULT_SUMMARIZER_PROVIDER: SummarizerProvider = 'anthropic';

/** Endpoint URL for openai-compatible provider. Required when provider=openai-compatible. */
export const ENV_OPENAI_ENDPOINT = 'CAPTAIN_MEMO_OPENAI_ENDPOINT';
/** Optional bearer token for openai-compatible provider (most local servers don't need this). */
export const ENV_OPENAI_API_KEY = 'CAPTAIN_MEMO_OPENAI_API_KEY';

// Hard contracts from spec §5 — defaults if env not set.
export const DEFAULT_HOOK_TIMEOUT_MS = 250;
export const DEFAULT_STOP_DRAIN_BUDGET_MS = 5_000;
export const DEFAULT_HOOK_BUDGET_TOKENS = 4_000;
export const DEFAULT_OBSERVATION_BATCH_SIZE = 20;
export const DEFAULT_OBSERVATION_TICK_MS = 5_000;
