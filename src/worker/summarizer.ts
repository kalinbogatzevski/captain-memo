import { z } from 'zod';
import type { RawObservationEvent } from '../shared/types.ts';
import type { SummarizerResult } from './index.ts';
import { DEFAULT_SUMMARIZER_MODEL, DEFAULT_SUMMARIZER_FALLBACKS } from '../shared/paths.ts';

const ObservationTypes = ['bugfix', 'feature', 'refactor', 'discovery', 'decision', 'change'] as const;

const SummaryJsonSchema = z.object({
  // Coerce an out-of-vocab type (the model occasionally invents e.g. 'review') to the
  // neutral default 'change' rather than failing the whole object — throwing away a good
  // observation (title/facts/concepts) over one wrong word is the wrong trade. Genuinely
  // structural failures (missing title, etc.) still reject in summarize().
  type: z.enum(ObservationTypes).catch('change'),
  title: z.string().min(1).max(200),
  narrative: z.string(),
  facts: z.array(z.string()),
  concepts: z.array(z.string()),
});

export interface SummarizerTransportArgs {
  /**
   * Model slug, or '' for "caller has no opinion — resolve it". ONLY
   * Summarizer.getTransport()'s wrapper honours the empty form; the bare
   * per-provider transports do not. codex/agy happen to tolerate it (they guard
   * on `args.model &&` and fall through to the account default), but claude-oauth
   * and claude-code put it straight on the wire → HTTP 400. Never hand a bare
   * transport to a caller that passes ''.
   */
  model: string;
  system: string;
  user: string;
  max_tokens: number;
}

export interface SummarizerTransportResult {
  content: Array<{ type: 'text'; text: string }>;
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
  /**
   * Why generation stopped ('end_turn' | 'max_tokens' | …), when the transport can
   * tell. Optional: the subprocess transports (codex/agy) have no equivalent.
   * Without it a truncated reply surfaces as a bare "Unterminated string" parse
   * error, which reads as "the model emitted junk" and sends you hunting the
   * wrong bug — the API already told us it ran out of room.
   */
  stop_reason?: string | null;
}

export type SummarizerTransport = (args: SummarizerTransportArgs) => Promise<SummarizerTransportResult>;

export interface SummarizerOptions {
  apiKey: string;
  /** Primary model. Default: DEFAULT_SUMMARIZER_MODEL (snapshot of current best small Claude). */
  model?: string;
  /**
   * Ordered fallback chain. Each entry is tried in turn on `model_not_found`
   * from the previous one. The first model that responds successfully is
   * cached for the worker's lifetime. Default: DEFAULT_SUMMARIZER_FALLBACKS.
   */
  fallbackModels?: string[];
  maxTokens?: number;
  transport?: SummarizerTransport;
}

const SYSTEM_PROMPT =
  `You are a session-observation summarizer for a developer's local memory layer.
Given a window of tool-use events, produce a single structured observation that
captures what changed, what was learned, and any reusable concept the developer
will want to retrieve later.

Output ONLY a single JSON object matching this schema, no prose around it:
{
  "type": "bugfix" | "feature" | "refactor" | "discovery" | "decision" | "change",
  "title": "short imperative summary, ≤80 chars",
  "narrative": "1-3 sentence prose summary",
  "facts": ["≤5 bullet-style atomic facts"],
  "concepts": ["≤5 short concept tags"]
}

CRITICAL — the output must be parseable JSON. Any double quote INSIDE a string
value must be escaped as \\". This matters most when the thing you are describing
is itself punctuation: writing (") unescaped ends the string early and the whole
observation is discarded. Prefer naming a character to quoting it — write
'ASCII double-quote' rather than ("). Same for backslashes (\\\\) and literal
newlines (\\n) inside values.`;

function buildUserPrompt(events: RawObservationEvent[]): string {
  const lines: string[] = [];
  lines.push(`Session: ${events[0]!.session_id}`);
  lines.push(`Project: ${events[0]!.project_id}`);
  lines.push(`Prompt: ${events[0]!.prompt_number}`);
  lines.push(`Events (${events.length}):`);
  for (const e of events) {
    lines.push(`- tool=${e.tool_name}`);
    lines.push(`  input: ${e.tool_input_summary}`);
    lines.push(`  result: ${e.tool_result_summary}`);
    if (e.files_modified.length > 0) lines.push(`  modified: ${e.files_modified.join(', ')}`);
    if (e.files_read.length > 0)     lines.push(`  read: ${e.files_read.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Escape interior double quotes the model forgot to escape.
 *
 * Models escape SOME quotes and not others — reliably so when the observation is
 * ABOUT punctuation ("...the proper closing " (U+201D)..."). Prompting does not fix
 * it, and a second API call to self-repair is neither free nor deterministic.
 *
 * The grammar makes it decidable: a JSON string ends only where the next non-space
 * character is , : } ] or end-of-input. Every other '"' inside a string must be a
 * literal, so escape it. Already-escaped quotes and backslash pairs are skipped.
 *
 * ponytail: quotes only — the failure we actually observe. Raw control characters
 * would need the same treatment; add it if they ever show up in a last_error.
 */
export function repairJsonQuotes(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (ch === '\\') {                 // escape pair — copy both, never inspect the 2nd
      out += ch + (text[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      const next = text[j];
      if (next === undefined || next === ',' || next === ':' || next === '}' || next === ']') {
        out += ch;                     // structural: really closes the string
        inString = false;
      } else {
        out += '\\"';                  // literal the model left bare
      }
      continue;
    }
    out += ch;
  }
  return out;
}

/** One-line, length-capped echo of a model reply for error messages. The worker stores
 *  last_error at 200 chars, so keep it tight — enough to spot a stray quote, not a dump. */
function trimForLog(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** A "that model doesn't exist for this account" error — the only failure the chain walks past. */
function isModelMissing(err: unknown): boolean {
  const e = err as Error & { status?: number; error?: { type?: string } };
  return (
    e.status === 404 ||
    /model_not_found|not_found/.test(e.message ?? '') ||
    e.error?.type === 'not_found_error'
  );
}

export class Summarizer {
  private apiKey: string;
  private primaryModel: string;
  private fallbackModels: string[];
  private activeModel: string;
  private maxTokens: number;
  private transport: SummarizerTransport;

  constructor(opts: SummarizerOptions) {
    // apiKey is only required for the default Anthropic SDK transport.
    // Custom transports (e.g. the Claude Code subprocess transport) authenticate
    // via their own mechanism and pass apiKey='' or a placeholder.
    if (!opts.transport && !opts.apiKey) {
      throw new Error('Summarizer: apiKey required when using default transport');
    }
    this.apiKey = opts.apiKey;
    this.primaryModel = opts.model ?? DEFAULT_SUMMARIZER_MODEL;
    // De-dup the chain — if the caller put the primary into fallbacks too, drop it
    // (calling the same model twice on a 404 just wastes a request).
    const rawChain = opts.fallbackModels ?? DEFAULT_SUMMARIZER_FALLBACKS;
    this.fallbackModels = rawChain.filter(m => m && m !== this.primaryModel);
    this.activeModel = this.primaryModel;
    this.maxTokens = opts.maxTokens ?? 800;
    this.transport = opts.transport ?? this.defaultTransport.bind(this);
  }

  /**
   * Default Anthropic SDK transport. Swappable via constructor for tests.
   */
  private async defaultTransport(args: SummarizerTransportArgs): Promise<SummarizerTransportResult> {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: this.apiKey });
    const res = await client.messages.create({
      model: args.model,
      system: args.system,
      max_tokens: args.max_tokens,
      messages: [{ role: 'user', content: args.user }],
    });
    // The Anthropic SDK's ContentBlock is a discriminated union (TextBlock |
    // ThinkingBlock | …). We only emit text content downstream, so narrow + repack.
    const content: Array<{ type: 'text'; text: string }> = [];
    for (const c of res.content ?? []) {
      if (c.type === 'text') {
        content.push({ type: 'text', text: (c as { text: string }).text });
      }
    }
    const sdkUsage = (res as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    const usage = (sdkUsage?.input_tokens !== undefined && sdkUsage?.output_tokens !== undefined)
      ? { input_tokens: sdkUsage.input_tokens, output_tokens: sdkUsage.output_tokens }
      : undefined;
    return { content, model: res.model, ...(usage && { usage }) };
  }

  /**
   * Send `args` through the model chain. An empty `args.model` means "you pick" —
   * it resolves to the active model rather than going on the wire as "" (which
   * api.anthropic.com rejects with 400 "model: String should have at least 1
   * character"). Walks the fallbacks on model-not-found only; every other error
   * propagates untouched so a 429 still reads as a 429 upstream.
   *
   * Shared by summarize() and getTransport() so the chain is resolved in exactly
   * one place — writeMemory drives the raw transport and must not have to know
   * which provider needs a model spelled out and which defaults on its own.
   */
  private async runWithModelChain(args: SummarizerTransportArgs): Promise<SummarizerTransportResult> {
    const candidates = [args.model || this.activeModel, ...this.fallbackModels]
      .filter((m, i, all) => Boolean(m) && all.indexOf(m) === i);
    let lastErr: unknown = null;
    for (const candidate of candidates) {
      try {
        const response = await this.transport({ ...args, model: candidate });
        this.activeModel = candidate;
        return response;
      } catch (err) {
        lastErr = err;
        if (!isModelMissing(err)) throw err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Summarizer: no model in chain succeeded — ${candidates.join(', ')}`);
  }

  async summarize(events: RawObservationEvent[]): Promise<SummarizerResult> {
    if (events.length === 0) {
      return {
        type: 'change',
        title: 'no events',
        narrative: '',
        facts: [],
        concepts: [],
      };
    }

    const response = await this.runWithModelChain({
      model: this.activeModel,
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(events),
      max_tokens: this.maxTokens,
    });

    const textBlock = response.content.find(c => c.type === 'text');
    if (!textBlock) throw new Error('Summarizer: response had no text block');

    // Ran out of output budget → the JSON is cut off mid-token. Say THAT, instead of
    // letting it fall through to an "Unterminated string" parse error that looks
    // identical to the model emitting malformed JSON. Different cause, different fix
    // (raise max_tokens vs. fix the prompt), so they must not share an error message.
    if (response.stop_reason === 'max_tokens') {
      throw new Error(
        `Summarizer: response truncated at max_tokens (${this.maxTokens}) — raise ` +
        `maxTokens or shrink the batch; the JSON is incomplete, not malformed`,
      );
    }

    let json: unknown;
    try {
      // GREEDY on purpose: first '{' to LAST '}'. The model often wraps the object in a
      // ```json fence, whose closing ``` sits after the final brace — a lazy match would
      // stop at the first '}' and break every fenced reply. Do not "fix" this.
      const match = /\{[\s\S]*\}/.exec(textBlock.text);
      const candidate = match ? match[0] : textBlock.text;
      try {
        json = JSON.parse(candidate);
      } catch {
        // Second chance: the model left an interior quote bare. Deterministic repair,
        // no extra API call. If it still fails we fall into the catch below with the
        // ORIGINAL error, so the log shows what the model actually sent.
        json = JSON.parse(repairJsonQuotes(candidate));
      }
    } catch (err) {
      // Include the text. The usual cause is an UNESCAPED `"` inside a string value
      // (observations ABOUT punctuation are the reliable trigger), and without the
      // offending snippet in the log that is indistinguishable from truncation —
      // it cost a full replay-against-the-API to tell the two apart once already.
      throw new Error(
        `Summarizer: failed to parse JSON: ${(err as Error).message} — raw: ${trimForLog(textBlock.text)}`,
      );
    }

    const parsed = SummaryJsonSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Summarizer: response failed schema validation: ${parsed.error.message}`);
    }
    // Surface (don't silently swallow) a coerced out-of-vocab type, so the prompt can be
    // tuned or the vocabulary extended if the model keeps inventing one.
    const rawType = (json as { type?: unknown }).type;
    if (typeof rawType === 'string' && rawType !== parsed.data.type) {
      console.warn(`[summarizer] coerced unknown observation type '${rawType}' -> '${parsed.data.type}'`);
    }
    return {
      ...parsed.data,
      ...(response.usage && { usage: response.usage }),
    };
  }

  /** Exposed for tests + diagnostics. */
  getActiveModel(): string {
    return this.activeModel;
  }

  /**
   * The model-fallback transport, for callers that need the raw request shape
   * rather than the observation-shaped summarize() (writeMemory's frontmatter
   * fill + merge). Wrapped, not the bare transport: callers pass model:'' to
   * mean "you pick", and only this wrapper knows what to pick.
   */
  getTransport(): SummarizerTransport {
    return (args) => this.runWithModelChain(args);
  }
}
