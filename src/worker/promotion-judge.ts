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
    // COERCED, not z.number(): the model quotes it ("134317") often enough that a strict number
    // rejected the entire batch of 20 over one pair of quotes. Observed on the very first live run.
    // Coercion still fails closed on genuine rubbish — "abc" becomes NaN and the row is dropped —
    // so this buys tolerance for a formatting habit, not for a wrong answer.
    sourceObservationId: z.coerce.number().int().positive(),
    type: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    body: z.string().min(1),
  })),
});

// TUNED against a measured shadow run. The first version said "MOST observations are NOT worth
// promoting; be selective" and kept 44% (35 of 80) — so a stronger adjective was never going to fix
// it. What it kept alongside real references: "Async checkpoint polling for Task 2 validation",
// "Establish hourly WOL SLA-breach monitoring loop until resolution", "Multi-tenant dispatch board
// visibility investigation workflow". All three are what-I-was-doing-on-Tuesday, not remember-forever.
// So this version replaces the adjective with three things a model can actually apply: ONE decision
// test, the anti-patterns actually observed, and a base-rate anchor. The schema now also states that
// sourceObservationId is a BARE NUMBER — it was returning it quoted, which rejected whole batches.
const SYSTEM_PROMPT =
  `You are the curator of a developer's long-term memory. You are given session observations and
decide which deserve to be REMEMBERED FOREVER as curated memory.

THE TEST — apply it to every observation, and when in doubt, leave it out:
  "Would this still be USEFUL IN SIX MONTHS to someone who does NOT know what happened this week?"

KEEP things that stay true after the work that produced them is finished:
  - a decision and the reason behind it ("we chose X over Y because Z")
  - a durable fact about a system: a config key, a threshold, a schema, an endpoint contract
  - a trap, gotcha, or root cause that would otherwise be rediscovered the hard way
  - a stated preference or convention ("always do X here")

DROP anything that is a record of activity rather than knowledge. Real examples that were wrongly
kept, and must not be:
  - task/progress mechanics: "Task 2 validated, advancing to Task 3", "scheduled a checkpoint poll"
  - temporary operational loops: "monitor ticket #164451 hourly until resolved"
  - session workflow narration: "decomposed the investigation into five trace paths"
  - "implemented <feature>" with no durable fact — the code IS the record; the memory is only
    worth keeping if it captures WHY, or a constraint the code does not state
  - anything whose value expires when the ticket closes, the run finishes, or the branch merges

BASE RATE: typically 0-3 of every 20 qualify. Returning an empty list is a correct, common answer.
A false keep is expensive — it permanently dilutes recall for everything else — while a false drop
costs nothing, because the observation remains searchable where it already lives.

Output ONLY a single JSON object, no prose:
{
  "promote": [
    {
      "sourceObservationId": <bare number, unquoted, exactly as presented>,
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

/** A judge run either produced verdicts or FAILED. These are not the same thing and must never
 *  collapse into one value.
 *
 *  Every failure path here used to `return []` — transport error, no text block, unparseable JSON,
 *  schema mismatch — which is byte-identical to the judge saying "none of these 20 qualify". That was
 *  survivable only while nothing recorded the answer. The moment a decline is STAMPED (v23), one
 *  transient parse failure would permanently retire 20 observations that were never actually judged.
 *  So: `ok:false` means we learned nothing, and the caller must stamp nothing. */
export type JudgeOutcome =
  | { ok: true; verdicts: PromotionVerdict[] }
  | { ok: false; error: string };

/** Output budget for ONE judge call. Each survivor carries a fully distilled `body`, so the response
 *  is not small: the old 1500 truncated the JSON mid-array at roughly three survivors, and truncation
 *  landed in the `catch` above as an empty verdict — the failure this type now makes visible. Sized
 *  against the batch: ~20 rows in, worst case every row survives with a real body. */
export const DEFAULT_JUDGE_MAX_TOKENS = 8000;

/** Build the PromotionDeps.judge function from a SummarizerTransport. */
export function buildPromotionJudge(
  generate: SummarizerTransport,
  opts: { model?: string; maxTokens?: number } = {},
): (rows: Observation[]) => Promise<JudgeOutcome> {
  return async (rows: Observation[]): Promise<JudgeOutcome> => {
    if (rows.length === 0) return { ok: true, verdicts: [] }; // never call the model on nothing
    const presented = new Set(rows.map(r => r.id));
    let text: string;
    try {
      const res = await generate({
        // '' = "transport, pick from your resolved chain", exactly as memory-writer does. The old
        // literal 'haiku' went on the wire as a model id, 404'd, and the chain then walked to
        // DEFAULT_SUMMARIZER_FALLBACKS' claude-haiku-4-6 which 404s too — so the call ALWAYS failed
        // and the old `return []` reported it as "nothing qualified". Migration v22's note records
        // the consequence on the theme path: "279 clusters considered, 279 declined, 0 written".
        // They were never judged.
        model: opts.model ?? '',
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(rows),
        max_tokens: opts.maxTokens ?? DEFAULT_JUDGE_MAX_TOKENS,
      });
      const block = res.content.find(c => c.type === 'text');
      if (!block) return { ok: false, error: 'judge returned no text block' };
      text = block.text;
    } catch (err) {
      return { ok: false, error: `judge transport failed: ${(err as Error).message}` };
    }
    let json: unknown;
    try {
      const match = /\{[\s\S]*\}/.exec(text);
      json = JSON.parse(match ? match[0] : text);
    } catch {
      // Overwhelmingly the truncation case: a valid prefix with no closing brace.
      return { ok: false, error: `judge output was not parseable JSON (${text.length} chars; likely truncated — raise maxTokens or shrink the batch)` };
    }
    const parsed = VerdictSchema.safeParse(json);
    if (!parsed.success) return { ok: false, error: `judge output did not match the verdict schema: ${parsed.error.message.slice(0, 200)}` };
    return {
      ok: true,
      verdicts: parsed.data.promote
        .filter(v => presented.has(v.sourceObservationId))
        .map(v => ({
          sourceObservationId: v.sourceObservationId,
          type: v.type,
          name: v.name,
          description: v.description,
          body: v.body,
        })),
    };
  };
}
