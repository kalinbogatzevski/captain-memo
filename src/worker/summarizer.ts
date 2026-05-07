import { z } from 'zod';
import type { RawObservationEvent } from '../shared/types.ts';
import type { SummarizerResult } from './index.ts';
import { DEFAULT_HAIKU_MODEL, DEFAULT_HAIKU_FALLBACKS } from '../shared/paths.ts';

const ObservationTypes = ['bugfix', 'feature', 'refactor', 'discovery', 'decision', 'change'] as const;

const SummaryJsonSchema = z.object({
  type: z.enum(ObservationTypes),
  title: z.string().min(1).max(200),
  narrative: z.string(),
  facts: z.array(z.string()),
  concepts: z.array(z.string()),
});

export interface SummarizerTransportArgs {
  model: string;
  system: string;
  user: string;
  max_tokens: number;
}

export interface SummarizerTransportResult {
  content: Array<{ type: 'text'; text: string }>;
  model: string;
}

export type SummarizerTransport = (args: SummarizerTransportArgs) => Promise<SummarizerTransportResult>;

export interface HaikuSummarizerOptions {
  apiKey: string;
  /** Primary model. Default: DEFAULT_HAIKU_MODEL (snapshot of current best small Claude). */
  model?: string;
  /**
   * Ordered fallback chain. Each entry is tried in turn on `model_not_found`
   * from the previous one. The first model that responds successfully is
   * cached for the worker's lifetime. Default: DEFAULT_HAIKU_FALLBACKS.
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

export class HaikuSummarizer {
  private apiKey: string;
  private primaryModel: string;
  private fallbackModels: string[];
  private activeModel: string;
  private maxTokens: number;
  private transport: SummarizerTransport;

  constructor(opts: HaikuSummarizerOptions) {
    if (!opts.apiKey) throw new Error('HaikuSummarizer: apiKey required');
    this.apiKey = opts.apiKey;
    this.primaryModel = opts.model ?? DEFAULT_HAIKU_MODEL;
    // De-dup the chain — if the caller put the primary into fallbacks too, drop it
    // (calling the same model twice on a 404 just wastes a request).
    const rawChain = opts.fallbackModels ?? DEFAULT_HAIKU_FALLBACKS;
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
    return { content, model: res.model };
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

    const args: SummarizerTransportArgs = {
      model: this.activeModel,
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(events),
      max_tokens: this.maxTokens,
    };

    const isModelMissing = (err: unknown): boolean => {
      const e = err as Error & { status?: number; error?: { type?: string } };
      return (
        e.status === 404 ||
        /model_not_found|not_found/.test(e.message ?? '') ||
        e.error?.type === 'not_found_error'
      );
    };

    const candidates = [this.activeModel, ...this.fallbackModels];
    let response: SummarizerTransportResult | null = null;
    let lastErr: unknown = null;
    for (const candidate of candidates) {
      try {
        response = await this.transport({ ...args, model: candidate });
        this.activeModel = candidate;
        break;
      } catch (err) {
        lastErr = err;
        if (!isModelMissing(err)) throw err;
      }
    }
    if (response === null) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error(`HaikuSummarizer: no model in chain succeeded — ${candidates.join(', ')}`);
    }

    const textBlock = response.content.find(c => c.type === 'text');
    if (!textBlock) throw new Error('HaikuSummarizer: response had no text block');

    let json: unknown;
    try {
      const match = /\{[\s\S]*\}/.exec(textBlock.text);
      json = JSON.parse(match ? match[0] : textBlock.text);
    } catch (err) {
      throw new Error(`HaikuSummarizer: failed to parse JSON: ${(err as Error).message}`);
    }

    const parsed = SummaryJsonSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`HaikuSummarizer: response failed schema validation: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  /** Exposed for tests + diagnostics. */
  getActiveModel(): string {
    return this.activeModel;
  }
}
