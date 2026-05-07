import { encode } from 'gpt-tokenizer';

export function countTokens(text: string): number {
  if (!text) return 0;
  return encode(text).length;
}

const TRUNCATION_MARKER = '… [truncated]';

/**
 * Truncate `text` so that countTokens(result) <= budgetTokens.
 *
 * Strategy: binary-chop the character length downward until the token count
 * fits, then append the truncation marker. Cheap enough for envelope-sized
 * inputs (≤ a few thousand tokens). Not a streaming tokenizer.
 */
export function truncateToTokenBudget(text: string, budgetTokens: number): string {
  if (budgetTokens <= 0) return TRUNCATION_MARKER;
  if (countTokens(text) <= budgetTokens) return text;

  let lo = 0;
  let hi = text.length;
  // Reserve some tokens for the marker itself
  const markerTokens = countTokens(TRUNCATION_MARKER);
  const target = Math.max(0, budgetTokens - markerTokens);

  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const candidate = text.slice(0, mid);
    if (countTokens(candidate) <= target) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo).trimEnd() + TRUNCATION_MARKER;
}
