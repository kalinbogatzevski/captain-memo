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

// Ordered fallback chain — each model is tried on `model_not_found` from the previous one. The
// first successful model is cached for the worker's lifetime.
//
// BOTH PREVIOUS ENTRIES WERE DEAD, so this chain had no working fallback at all: if the primary
// became unavailable the summarizer stopped, taking observations and cross-AI capture with it.
// PROBED against api.anthropic.com with this account's own OAuth credentials (2026-08-09):
//
//   claude-haiku-4-5              200  <- primary
//   claude-haiku-4-5-20251001     200
//   claude-sonnet-5               200
//   claude-sonnet-4-5             200
//   claude-haiku-4-6              404  <- was fallback #1 ("next-newer release"; never shipped)
//   haiku                         404  <- was fallback #2 ("safe alias"; the API takes no aliases)
//   sonnet                        404
//
// The "safe alias" assumption is the load-bearing error: api.anthropic.com resolves FULL model ids
// only, so no bare alias can ever serve as a last resort. It is also why the promotion and theme
// judges — which passed a literal 'haiku' — had never once reached a model.
//
// The chain now degrades along two independent axes: a DATE-PINNED build of the same model (survives
// an alias being retired), then a DIFFERENT FAMILY (survives haiku being unavailable outright).
// Sonnet costs more per token; it only ever runs when the cheap path is already broken, and a dearer
// summary beats none. Override via CAPTAIN_MEMO_SUMMARIZER_FALLBACKS.
export const DEFAULT_SUMMARIZER_FALLBACKS: string[] = ['claude-haiku-4-5-20251001', 'claude-sonnet-5'];

// `claude-code` shells out to the CLI, and the CLI is the one Anthropic surface that takes
// family ALIASES ('haiku', 'sonnet', 'opus', 'fable') and resolves them to the CURRENT release —
// verified in the shipped CLI's own accepted-alias list. api.anthropic.com does NOT (full ids
// only; every alias 404s — probed 2026-08-09, see DEFAULT_SUMMARIZER_FALLBACKS above), which is
// why the two paths need different defaults and why the API providers keep a dated id.
//
// So this line never has to be maintained: 'haiku' is always the current cheapest tier, and the
// chain floors at the sentinel (= pass no --model, summarizer-claude-code.ts) so even a retired
// alias cannot leave the summarizer with nothing to call.
export const DEFAULT_CLAUDE_CODE_MODEL = 'haiku';
export const DEFAULT_CLAUDE_CODE_FALLBACKS: string[] = ['default'];

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
 *                          `codex login`.
 *  - 'agy'               — `agy -p` subprocess on a GOOGLE account (Antigravity CLI).
 *                          The widest-reach zero-key option: no Claude plan, no ChatGPT
 *                          plan, no API key. ~3.4-5.5 s/call — fastest of the three
 *                          agent-CLI transports. Requires agy >= 1.1.1. */
export type SummarizerProvider = 'claude-oauth' | 'anthropic' | 'claude-code' | 'openai-compatible' | 'codex' | 'agy';
export const DEFAULT_SUMMARIZER_PROVIDER: SummarizerProvider = 'claude-oauth';

// Codex model defaults. Deliberately separate from DEFAULT_SUMMARIZER_MODEL —
// that one is a Claude slug, and handing a Claude slug to `codex exec` is an
// instant 400. The worker substitutes these when provider=codex and the user
// hasn't pinned CAPTAIN_MEMO_SUMMARIZER_MODEL themselves.
//
// The default is the SENTINEL 'default' — "send no -m at all", so Codex uses the
// account's own model (summarizer-codex.ts:CODEX_ACCOUNT_DEFAULT). It used to name a
// slug: gpt-5.4-mini, picked as the cheapest Haiku-tier model a ChatGPT account would
// accept. That rots. A ChatGPT account gates models SERVER-SIDE and PER PLAN, the slugs
// turn over every few months, and nothing offline can enumerate them (there is no
// `codex models`, and `-m` documents no values) — so the installer was handing new
// captains a retired slug (field 2026-09-01: gpt-5.4-mini, gone) that cost a wasted
// ~6-7s `codex exec` boot per rejected candidate on every worker start before the chain
// walked down to this sentinel anyway. Naming no model is the only choice that cannot
// rot and cannot 400. Pin CAPTAIN_MEMO_SUMMARIZER_MODEL yourself if your plan gives you
// a cheaper tier worth saving quota on — the sentinel stays in the fallback chain as the
// floor under that pin (it de-dups away when it IS the primary).
export const DEFAULT_CODEX_MODEL = 'default';
export const DEFAULT_CODEX_FALLBACKS: string[] = ['default'];

// Antigravity (`agy`): same reasoning as codex above, same sentinel (= pass no --model,
// summarizer-agy.ts:AGY_ACCOUNT_DEFAULT). Its names are DISPLAY names, not slugs — what
// `agy models` prints and what `--model` accepts — and they turn over with the model
// line ('Gemini 3.5 Flash (Low)' was the measured cheapest-and-fastest pick). agy at
// least fails loudly on an unknown value (exits 1, lists the valid ones), but a default
// nobody can keep current is still a default that ages into a wrong one.
export const DEFAULT_AGY_MODEL = 'default';
export const DEFAULT_AGY_FALLBACKS: string[] = ['default'];

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
/** COSINE similarity at or above which `remember` REPORTS an existing memory as a near-duplicate.
 *  Reporting only — nothing is folded or rewritten on this signal (see findNearDuplicate). A fold
 *  happens solely on an explicit filename collision.
 *
 *  CALIBRATED against the live 812-memory corpus rather than guessed. Cosine to the nearest OTHER
 *  memory, measured across every one of them:
 *
 *    max 0.9554 | p99 0.9326 | p95 0.8983 | p90 0.8781 | p50 0.7909
 *
 *  Two populations with a real gap between them. Genuine duplicates cluster 0.93-0.96 —
 *  aj_table_gen_param_binding_bug vs aj_table_gen_bound_params_fatal (0.9554), bump-deploy-version
 *  vs bump_erp_version (0.9479), no_fa4_icons vs use_fa6_icons (0.9389). Merely-related material
 *  sits far below (p50 0.79, p90 0.88). 0.93 sits in the gap: it surfaces the handful of true
 *  duplicates and stays quiet about the rest. Counts at other values, same corpus: 0.90 -> 35 docs
 *  (4.3%), 0.85 -> 152 (18.7%), 0.80 -> 362 (44.6%) — noise, not duplicates.
 *
 *  Because this now drives a REPORT and not a rewrite, a false positive costs a line of output
 *  rather than an LLM silently editing a memory nobody named. Was 0.99 when it gated a fold; before
 *  that, 0.85 compared against `1 - L2distance`, which really meant cos 0.98875 — high enough that
 *  nothing in today's corpus can reach it. (Whether it ever fired historically is unknowable: a fold
 *  consumes the pair that would have evidenced it.) */
export const DEFAULT_REMEMBER_DEDUP_THRESHOLD = 0.93;

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
export const ENV_CLAUDE_PROJECTS_DIR = 'CAPTAIN_MEMO_CLAUDE_PROJECTS_DIR';

/** Root that per-project curated memory is written under: <root>/<project-slug>/memory.
 *
 *  Overridable for ONE reason: test isolation. A `remember` carrying a cwd resolves its file path from
 *  this root, and that path used to be a hardcoded homedir() — so a test that spun up a worker with
 *  `:memory:` databases still wrote a REAL markdown file into the developer's own
 *  ~/.claude/projects/<slug>/memory, where a live worker's watcher would index it. In-memory databases
 *  isolate the INDEX; they do not isolate a file write. Measured on the sibling line 2026-08-30: a
 *  suite run planted six fixture entries in the real corpus, which then surfaced in an unrelated
 *  session's auto-recall.
 *
 *  Same shape as the CAPTAIN_MEMO_CONFIG_DIR fix that stopped tests inheriting the developer's real
 *  worker.env. Production never sets this. */
export function claudeProjectsDir(): string {
  return process.env[ENV_CLAUDE_PROJECTS_DIR] ?? join(homedir(), '.claude', 'projects');
}

export function projectSlugFromCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}
