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

/** One entry mapped, or null when the token is not a provider we know. */
function mapOne(raw: string): SummarizerProvider | null {
  switch (raw.toLowerCase().trim()) {
    case 'claude-oauth': return 'claude-oauth';
    case 'claude-code': return 'claude-code';
    case 'openai-compatible':
    case 'openai': return 'openai-compatible';
    case 'anthropic': return 'anthropic';
    case 'codex': return 'codex';
    case 'agy':
    case 'antigravity': return 'agy';
    default: return null;
  }
}

export interface ResolvedProviders {
  /** Ordered preference list. Never empty. The worker probes these in order at boot and the
   *  FIRST one that can actually run becomes the summarizer for that worker's lifetime. */
  providers: SummarizerProvider[];
  warning?: string;
}

/**
 * Map a raw env value to an ORDERED provider chain.
 *
 * A comma-separated list used to be an ERROR here ("only ONE is supported"), which quietly fell
 * back to claude-oauth — on a box with no Claude login that summarized nothing. It is now the
 * feature: `codex,claude-oauth,agy` means "prefer codex, else Claude, else agy". A single value
 * keeps exactly today's meaning, so every existing worker.env is unaffected.
 *
 * Unknown entries are DROPPED with a warning rather than failing the whole list — one typo in a
 * three-provider chain should cost that entry, not the summarizer. If nothing survives, we return
 * the default and say so loudly.
 */
export function resolveSummarizerProviders(raw: string | undefined): ResolvedProviders {
  const tokens = (raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (tokens.length === 0) return { providers: [DEFAULT_SUMMARIZER_PROVIDER] };

  const providers: SummarizerProvider[] = [];
  const bad: string[] = [];
  for (const tok of tokens) {
    const mapped = mapOne(tok);
    if (!mapped) { bad.push(tok); continue; }
    if (!providers.includes(mapped)) providers.push(mapped);   // de-dup, keep first position
  }

  if (providers.length === 0) {
    return {
      providers: [DEFAULT_SUMMARIZER_PROVIDER],
      warning:
        `no valid provider in "${raw}" (unrecognized: ${bad.join(', ')}). Valid: ${VALID_SUMMARIZER_PROVIDERS}. ` +
        `Falling back to '${DEFAULT_SUMMARIZER_PROVIDER}', which needs a Claude login — ` +
        `on a machine with no Claude, set a real provider or nothing gets summarized.`,
    };
  }
  if (bad.length > 0) {
    return {
      providers,
      warning: `ignored unrecognized provider(s): ${bad.join(', ')}. Valid: ${VALID_SUMMARIZER_PROVIDERS}. ` +
               `Using: ${providers.join(' -> ')}`,
    };
  }
  return { providers };
}

/** Single-provider view of the same resolution — the head of the chain (what the customer put
 *  first). Kept so callers that only care about the configured preference stay unchanged. */
export function resolveSummarizerProvider(raw: string | undefined): ResolvedProvider {
  const { providers, warning } = resolveSummarizerProviders(raw);
  return warning ? { provider: providers[0]!, warning } : { provider: providers[0]! };
}
