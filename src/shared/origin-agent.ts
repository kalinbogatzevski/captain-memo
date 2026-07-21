/**
 * Vendor provenance: which AI agent authored a captured memory/observation.
 *
 * Mirrors the `origin_peer` tag (which captain a memory came from)
 * but at the agent layer (which CLI/tool produced it). Stored alongside `branch`
 * on each observation and surfaced in search / get_full result metadata so a
 * consumer can see who wrote a memory.
 *
 * Closed set — `unknown` is the safe default for old rows and for any env we
 * can't classify. Additive + backward-compatible: a row with no recorded agent
 * reads back as null at the store layer and is rendered as 'unknown' to callers.
 */
export const ORIGIN_AGENTS = [
  'claude-code', 'codex', 'cursor', 'gemini', 'agy', 'opencode', 'kimi', 'vibe', 'vscode', 'jetbrains', 'unknown',
] as const;

export type OriginAgent = (typeof ORIGIN_AGENTS)[number];

/** Default when no signal identifies the agent. */
export const UNKNOWN_ORIGIN_AGENT: OriginAgent = 'unknown';

/** Narrow an unknown value to an OriginAgent, or null when it isn't one. */
export function asOriginAgent(v: unknown): OriginAgent | null {
  return typeof v === 'string' && (ORIGIN_AGENTS as readonly string[]).includes(v)
    ? (v as OriginAgent)
    : null;
}

/**
 * Detect the originating AI agent from environment signals. Best-effort and
 * NEVER throws (mirrors detectBranchSync): an absent or unrecognizable env
 * always resolves to a valid OriginAgent, defaulting to 'unknown'.
 *
 * Precedence:
 *  1. An explicit, RECOGNIZED `AI_AGENT` value (case/space-insensitive) — the
 *     authoritative override a vendor or wrapper can set deliberately.
 *  2. `CLAUDECODE` set to a non-empty value → 'claude-code' (Claude Code exports
 *     CLAUDECODE=1 into the hook/tool environment).
 *  3. `CLAUDE_CODE_ENTRYPOINT` set to a non-empty value → 'claude-code'.
 *  4. Otherwise → 'unknown'.
 *
 * The other 7 vendors (codex/cursor/gemini/opencode/vibe/vscode/jetbrains) have
 * no verified env-var signal today — none has a hook path that calls this
 * function yet — so they're reachable only via the explicit AI_AGENT override.
 *
 * `env` is injected (defaults to process.env) purely so callers/tests stay
 * hermetic; production hooks call detectOriginAgent() with no args.
 */
export function detectOriginAgent(
  env: Record<string, string | undefined> | undefined = process.env,
): OriginAgent {
  const e = env ?? {};

  const explicit = asOriginAgent((e.AI_AGENT ?? '').trim().toLowerCase());
  if (explicit) return explicit;

  if ((e.CLAUDECODE ?? '').length > 0) return 'claude-code';
  if ((e.CLAUDE_CODE_ENTRYPOINT ?? '').length > 0) return 'claude-code';

  return UNKNOWN_ORIGIN_AGENT;
}
