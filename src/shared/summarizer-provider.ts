// src/shared/summarizer-provider.ts — parse CAPTAIN_MEMO_SUMMARIZER_PROVIDER into a valid provider.
//
// Extracted from the worker so it is pure + unit-testable. The idiot-proof job here: an
// unrecognized value must FAIL LOUD with the valid list — never silently pick a provider the
// box can't use. The specific trap this closes: a customer who tried to enable two providers
// (e.g. `codex,agy`) previously got a quiet fallback to 'claude-oauth', which on a no-Claude
// machine summarizes NOTHING with no obvious signal.

import { DEFAULT_SUMMARIZER_PROVIDER, type SummarizerProvider } from './paths.ts';

/** Human-readable list of the accepted values (for error messages). Order = recommendation-ish. */
export const VALID_SUMMARIZER_PROVIDERS = 'claude-oauth | codex | agy | anthropic | claude-code | openai-compatible';

export interface ResolvedProvider {
  provider: SummarizerProvider;
  /** Set when the raw value was not understood — the caller logs it loudly. */
  warning?: string;
}

/**
 * Map a raw env value to a provider. Accepts the aliases `openai`→openai-compatible and
 * `antigravity`→agy. On anything else, returns the default provider AND a warning explaining
 * what was wrong (with special-casing for a comma, i.e. "tried to set more than one").
 */
export function resolveSummarizerProvider(raw: string | undefined): ResolvedProvider {
  const p = (raw ?? DEFAULT_SUMMARIZER_PROVIDER).toLowerCase().trim();
  switch (p) {
    case 'claude-oauth': return { provider: 'claude-oauth' };
    case 'claude-code': return { provider: 'claude-code' };
    case 'openai-compatible':
    case 'openai': return { provider: 'openai-compatible' };
    case 'anthropic': return { provider: 'anthropic' };
    case 'codex': return { provider: 'codex' };
    case 'agy':
    case 'antigravity': return { provider: 'agy' };
    default: {
      const why = p.includes(',')
        ? `you set more than one provider ("${raw}") — only ONE is supported, pick a single value`
        : `unrecognized value "${raw}"`;
      return {
        provider: DEFAULT_SUMMARIZER_PROVIDER,
        warning:
          `${why}. Valid: ${VALID_SUMMARIZER_PROVIDERS}. ` +
          `Falling back to '${DEFAULT_SUMMARIZER_PROVIDER}', which needs a Claude login — ` +
          `on a machine with no Claude, set a real provider or nothing gets summarized.`,
      };
    }
  }
}
