// src/eval/judge.ts — cached LLM relevance judge (graded 0..3). The LLM call is
// injected (JudgeDeps.call) so tests stay offline; defaultAnthropicCall wires the
// Anthropic SDK at temperature 0 for determinism. Used only for non-temporal
// classes; temporal queries use the deterministic oracle instead.
import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';

export type JudgeFn = (query: string, docText: string) => Promise<number>;

export interface JudgeDeps {
  call: (system: string, user: string) => Promise<string>;
  cache: Map<string, number>;
}

const SYSTEM =
  'You grade how well a document answers a search query. Reply with ONE digit only: ' +
  '0 (irrelevant), 1 (slightly), 2 (relevant), 3 (perfect answer). No other text.';

export function gradeFromReply(reply: string): number {
  const m = /([0-3])/.exec(reply);
  if (!m) {
    const any = /(\d+)/.exec(reply);
    if (!any) return 0;
    return Math.max(0, Math.min(3, parseInt(any[1]!, 10)));
  }
  return parseInt(m[1]!, 10);
}

function key(query: string, docText: string): string {
  return query + ' ' + createHash('sha1').update(docText).digest('hex');
}

export function makeJudge(deps: JudgeDeps): JudgeFn {
  return async (query, docText) => {
    const k = key(query, docText);
    const hit = deps.cache.get(k);
    if (hit !== undefined) return hit;
    const reply = await deps.call(SYSTEM, `Query: ${query}\n\nDocument:\n${docText.slice(0, 2000)}`);
    const grade = gradeFromReply(reply);
    deps.cache.set(k, grade);
    return grade;
  };
}

export async function defaultAnthropicCall(system: string, user: string): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('eval judge: ANTHROPIC_API_KEY is required (or run with --no-judge for oracle-only metrics)');
  }
  const client = new Anthropic();
  const model = process.env.CAPTAIN_MEMO_EVAL_JUDGE_MODEL ?? 'claude-haiku-4-5-20251001';
  const resp = await client.messages.create({
    model,
    max_tokens: 8,
    temperature: 0,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const block = resp.content.find(c => c.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}
