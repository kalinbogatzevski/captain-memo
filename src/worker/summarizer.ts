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
}`;

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

    let json: unknown;
    try {
      const match = /\{[\s\S]*\}/.exec(textBlock.text);
      json = JSON.parse(match ? match[0] : textBlock.text);
    } catch (err) {
      throw new Error(`Summarizer: failed to parse JSON: ${(err as Error).message}`);
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
