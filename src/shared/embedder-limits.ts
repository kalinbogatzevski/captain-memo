/**
 * Per-model max-input-token limits for embedders.
 *
 * Used by the worker to size-check chunks BEFORE they reach the embedder
 * API — preventing the silent tail-truncation that hosted Voyage applies
 * by default (truncation=true). Without this guard, content past a model's
 * max_seq_length is invisible to semantic search even though indexing
 * "succeeds": the API returns 200 + a vector for the first N tokens only.
 *
 * Numbers are nominal "max tokens per single input" as documented by each
 * provider. Call sites should apply a safety margin because gpt-tokenizer
 * (cl100k_base) — the local counter used by countTokens() — does not
 * exactly match Voyage's SentencePiece-derived tokenizer; counts can
 * differ by ~10–15% on code-heavy or multi-byte content.
 *
 * Keep this table conservative: when in doubt, pick the smaller number.
 * False rejections are recoverable (split + retry); silent truncations
 * are not (data is gone after embed).
 *
 * Sources:
 *   Voyage:  https://docs.voyageai.com/docs/embeddings
 *   OpenAI:  https://platform.openai.com/docs/models/embeddings
 */
export const EMBEDDER_MAX_TOKENS: Record<string, number> = {
  // Voyage hosted models (api.voyageai.com)
  'voyage-4-large':         32_000,
  'voyage-4-lite':          32_000,
  'voyage-3-large':         32_000,
  'voyage-3.5':             32_000,
  'voyage-3.5-lite':        32_000,
  'voyage-3-lite':          32_000,
  'voyage-code-3':          32_000,
  'voyage-code-2':          16_000,
  'voyage-finance-2':       32_000,
  'voyage-law-2':           16_000,

  // Voyage open-weights models (served via local sidecar; voyage-4-nano
  // is the small open-weights sibling and has a much smaller window).
  'voyage-4-nano':          512,

  // OpenAI hosted models
  'text-embedding-3-large': 8_192,
  'text-embedding-3-small': 8_192,
  'text-embedding-ada-002': 8_192,
};

/**
 * Conservative fallback for unknown model names. Picked to match the
 * smallest embedder we explicitly support (voyage-4-nano) so an unknown
 * model never silently truncates content. Users with a custom embedder
 * that supports more can override via CAPTAIN_MEMO_EMBEDDER_MAX_TOKENS.
 */
export const DEFAULT_EMBEDDER_MAX_TOKENS = 512;

/**
 * Look up a model's max input tokens. Strips an organization prefix
 * (e.g., `voyageai/voyage-4-nano` → `voyage-4-nano`) before lookup so
 * sidecar-style namespacing works without duplicate table entries.
 */
export function embedderMaxTokens(model: string): number {
  const normalized = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  return EMBEDDER_MAX_TOKENS[normalized] ?? DEFAULT_EMBEDDER_MAX_TOKENS;
}
