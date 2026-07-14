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

// Config dir holds worker.env (API keys etc). Kept SEPARATE from DATA_DIR to
// match the existing Linux layout (~/.config/captain-memo) and the platform
// idiom on Windows (%APPDATA%\captain-memo). On Linux the system-mode install
// also uses /etc/captain-memo/worker.env — see src/shared/worker-env.ts, which
// checks both. Override via CAPTAIN_MEMO_CONFIG_DIR.
export const CONFIG_DIR = process.env.CAPTAIN_MEMO_CONFIG_DIR ?? (
  process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'captain-memo')
    : join(homedir(), '.config', 'captain-memo')
);
export const WORKER_ENV_PATH = join(CONFIG_DIR, 'worker.env');

export const DEFAULT_WORKER_PORT = 39888;
export const DEFAULT_VOYAGE_ENDPOINT = 'http://localhost:8124/v1/embeddings';

// Plan-2 additions ─────────────────────────────────────────────────────

// Snapshot model name — what the summarizer asks the configured provider for.
// Default reflects the most-available small Anthropic model at time of writing
// (2026-05). The summarizer is provider-agnostic: set this to whatever model
// your endpoint serves (e.g. `gpt-4o-mini`, `qwen2.5:14b`, future Haikus).
// When newer Haiku models ship, prefer pointing the env var at them rather
// than editing this constant — that way users on different access tiers can
// each pick what works for them.
export const DEFAULT_SUMMARIZER_MODEL = 'claude-haiku-4-5';

// Ordered fallback chain — each model is tried on `model_not_found` from the
// previous one. The first successful model is cached for the worker's lifetime.
// Default tries the next-newer release for forward-compat, then the safe
// `haiku` alias as a last resort. Override via CAPTAIN_MEMO_SUMMARIZER_FALLBACKS.
export const DEFAULT_SUMMARIZER_FALLBACKS: string[] = ['claude-haiku-4-6', 'haiku'];

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
 *  - 'claude-oauth'      — Direct HTTPS to api.anthropic.com using the OAuth
 *                          access token Claude Code stored in ~/.claude/.credentials.json
 *                          (or the OS keychain on macOS/Windows). No API key, no
 *                          subprocess, no startup overhead. Requires `claude login`.
 *  - 'anthropic'         — Anthropic SDK + ANTHROPIC_API_KEY (explicit billing).
 *  - 'claude-code'       — `claude -p` subprocess; uses Max/Pro plan but pays
 *                          per-call subprocess startup cost (5–15 s). Useful if
 *                          OAuth token storage is unavailable.
 *  - 'openai-compatible' — POST /v1/chat/completions to CAPTAIN_MEMO_OPENAI_ENDPOINT;
 *                          works with Ollama, LM Studio, vLLM, llama.cpp, OpenAI,
 *                          OpenRouter, Together, Groq, DeepSeek, Mistral, etc.
 *  - 'codex'             — `codex exec` subprocess on a ChatGPT Plus/Pro account.
 *                          The only zero-key option for users with NO Anthropic
 *                          subscription. ~6-7 s/call (Codex agent boot, not
 *                          inference — flat across the model ladder). Requires
 *                          `codex login`. */
export type SummarizerProvider = 'claude-oauth' | 'anthropic' | 'claude-code' | 'openai-compatible' | 'codex';
export const DEFAULT_SUMMARIZER_PROVIDER: SummarizerProvider = 'claude-oauth';

// Codex model defaults. Deliberately separate from DEFAULT_SUMMARIZER_MODEL —
// that one is a Claude slug, and handing a Claude slug to `codex exec` is an
// instant 400. The worker substitutes these when provider=codex and the user
// hasn't pinned CAPTAIN_MEMO_SUMMARIZER_MODEL themselves.
//
// gpt-5.4-mini is the Haiku-tier pick: cheapest slug a ChatGPT account will
// actually accept (gpt-5.4-nano is rejected). The chain ends in 'default' — the
// sentinel for "send no -m at all" — because a ChatGPT account gates models
// server-side per plan, so the only candidate guaranteed not to 400 is the
// account's own default. See summarizer-codex.ts:CODEX_ACCOUNT_DEFAULT.
export const DEFAULT_CODEX_MODEL = 'gpt-5.4-mini';
export const DEFAULT_CODEX_FALLBACKS: string[] = ['gpt-5.5', 'default'];

/** Endpoint URL for openai-compatible provider. Required when provider=openai-compatible. */
export const ENV_OPENAI_ENDPOINT = 'CAPTAIN_MEMO_OPENAI_ENDPOINT';
/** Optional bearer token for openai-compatible provider (most local servers don't need this). */
export const ENV_OPENAI_API_KEY = 'CAPTAIN_MEMO_OPENAI_API_KEY';

// Hard contracts from spec §5 — defaults if env not set.
// 250 ms was too tight on slow CPUs — UserPromptSubmit silently aborted via
// AbortController, dropping the memory envelope with no signal. 1500 ms gives
// margin for embed + RRF fusion + envelope build. The user is already waiting
// for the model anyway, so a few hundred extra ms here is invisible.
export const DEFAULT_HOOK_TIMEOUT_MS = 1500;
export const DEFAULT_STOP_DRAIN_BUDGET_MS = 5_000;
export const DEFAULT_HOOK_BUDGET_TOKENS = 4_000;
export const DEFAULT_OBSERVATION_BATCH_SIZE = 20;
export const DEFAULT_OBSERVATION_TICK_MS = 5_000;

// ─── Captain Remember — curated-memory write path + autonomous promotion ───
// Design: docs/superpowers/specs/2026-06-13-captain-remember-design.md (§8).
// Promotion target / CLI default when no project cwd is present.
export const ENV_REMEMBER_DIR = 'CAPTAIN_MEMO_REMEMBER_DIR';
// Master switch for autonomous promotion. OFF by default — only the string '1' enables.
export const ENV_PROMOTE_ENABLE = 'CAPTAIN_MEMO_PROMOTE_ENABLE';
// Promotion tick cadence (ms) and per-run cap.
export const ENV_PROMOTE_INTERVAL_MS = 'CAPTAIN_MEMO_PROMOTE_INTERVAL_MS';
export const ENV_PROMOTE_MAX_PER_RUN = 'CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN';
// Semantic update-in-place similarity cutoff for writeMemory() dedup.
export const ENV_REMEMBER_DEDUP_THRESHOLD = 'CAPTAIN_MEMO_REMEMBER_DEDUP_THRESHOLD';

// Captain Remember defaults (§8). Tunable via the ENV_* names above.
// Promotion has no live session cwd, so it writes to this user-global dir by default.
export const DEFAULT_REMEMBER_DIR = join(homedir(), '.claude', 'memory');
export const DEFAULT_PROMOTE_INTERVAL_MS = 21_600_000; // 6h
export const DEFAULT_PROMOTE_MAX_PER_RUN = 5;
export const DEFAULT_REMEMBER_DEDUP_THRESHOLD = 0.85;

/**
 * Encode an absolute cwd into Claude Code's project-dir slug, matching the
 * directories under ~/.claude/projects/. Every NON-alphanumeric character
 * becomes '-', one-for-one (no trim, no dedupe of consecutive dashes); case,
 * digits, and existing dashes are preserved. Verified against real dirs:
 *   /home/kalin/projects/captain-memo  ->  -home-kalin-projects-captain-memo
 *   /home/kalin/projects/erp-platform/.claude-worktrees-x
 *                          ->  -home-kalin-projects-erp-platform--claude-worktrees-x
 * The double dash in the second case (the `/.` run) proves per-character
 * replacement, not run-collapse. '_' and '.' both map to '-' (e.g. the real
 * dir -home-kalin-projects-123net-aelita came from .../123net_aelita).
 */
export function projectSlugFromCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}
