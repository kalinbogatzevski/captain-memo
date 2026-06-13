// src/worker/promotion-judge.ts — wraps the SummarizerTransport (the model-fallback
// transport, NOT summarize()) into the PromotionDeps.judge contract. ONE pass over
// all candidates decides curated-worthy vs ephemeral and distills each survivor into
// {type,name,description,body}. Fail-safe by construction: an empty candidate list
// never calls the model; a malformed/empty/offline reply yields ZERO survivors, so a
// broken judge promotes NOTHING rather than writing garbage. Survivors referencing an
// id not actually presented are dropped (the model must not invent ids).
import { z } from 'zod';
import type { Observation } from '../shared/types.ts';
import type { SummarizerTransport } from './summarizer.ts';
import type { PromotionVerdict } from './promotion.ts';

const VerdictSchema = z.object({
  promote: z.array(z.object({
    sourceObservationId: z.number(),
    type: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    body: z.string().min(1),
  })),
});

const SYSTEM_PROMPT =
  `You are the curator of a developer's long-term memory. You are given recent
high-signal session observations. Decide which are worth REMEMBERING FOREVER as
curated memory — durable decisions, preferences, facts, and reusable knowledge —
versus ephemeral noise. MOST observations are NOT worth promoting; be selective.

Output ONLY a single JSON object, no prose:
{
  "promote": [
    {
      "sourceObservationId": <the id of a presented observation>,
      "type": "decision" | "preference" | "reference" | "feature" | "discovery",
      "name": "short title",
      "description": "one-line summary",
      "body": "the substance, in markdown; fold in the observation's facts"
    }
  ]
}
Include ONLY observations worth keeping. An empty "promote" array is correct when
none qualify. Never invent an id that was not presented.`;

function buildUserPrompt(rows: Observation[]): string {
  const lines: string[] = [`Observations (${rows.length}):`];
  for (const r of rows) {
    lines.push(`- id=${r.id} type=${r.type} title="${r.title}"`);
    if (r.narrative) lines.push(`  narrative: ${r.narrative}`);
    if (r.facts.length > 0) lines.push(`  facts: ${r.facts.join('; ')}`);
    if (r.concepts.length > 0) lines.push(`  concepts: ${r.concepts.join(', ')}`);
  }
  return lines.join('\n');
}

/** Build the PromotionDeps.judge function from a SummarizerTransport. */
export function buildPromotionJudge(
  generate: SummarizerTransport,
  opts: { model?: string; maxTokens?: number } = {},
): (rows: Observation[]) => Promise<PromotionVerdict[]> {
  return async (rows: Observation[]): Promise<PromotionVerdict[]> => {
    if (rows.length === 0) return []; // never call the model on nothing
    const presented = new Set(rows.map(r => r.id));
    let text: string;
    try {
      const res = await generate({
        model: opts.model ?? 'haiku',
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(rows),
        max_tokens: opts.maxTokens ?? 1500,
      });
      const block = res.content.find(c => c.type === 'text');
      if (!block) return [];
      text = block.text;
    } catch {
      return []; // offline / transport error ⇒ promote nothing, never block the run
    }
    let json: unknown;
    try {
      const match = /\{[\s\S]*\}/.exec(text);
      json = JSON.parse(match ? match[0] : text);
    } catch {
      return [];
    }
    const parsed = VerdictSchema.safeParse(json);
    if (!parsed.success) return [];
    return parsed.data.promote
      .filter(v => presented.has(v.sourceObservationId))
      .map(v => ({
        sourceObservationId: v.sourceObservationId,
        type: v.type,
        name: v.name,
        description: v.description,
        body: v.body,
      }));
  };
}
