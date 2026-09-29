import { encode } from 'gpt-tokenizer';

export function countTokens(text: string): number {
  if (!text) return 0;
  return encode(text).length;
}

// ponytail: a text longer than limit × 16 chars is taken as not fitting `limit` tokens without encoding it — the
// encoder is the cost (64 KiB of English: ~30 ms; one 5 000-char run of a letter: 650 ms to truncate). True of prose
// and code (measured 2026-09-28, gpt-tokenizer, chars/token: English 5.2, Bulgarian 2.0, TypeScript 4.1, JSON 2.8, a
// run of one letter 8); a long run of whitespace or of one separator character ('-', '=': 40-125 chars/token) is then
// cut shorter than it had to be — under the budget, never over.
const MAX_CHARS_PER_TOKEN = 16;

/** countTokens, or `limit + 1` for a text too long to fit `limit` tokens. */
export function countTokensUpTo(text: string, limit: number): number {
  return text.length > limit * MAX_CHARS_PER_TOKEN ? limit + 1 : countTokens(text);
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
  if (countTokensUpTo(text, budgetTokens) <= budgetTokens) return text;

  let lo = 0;
  let hi = Math.min(text.length, budgetTokens * MAX_CHARS_PER_TOKEN);
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
