// src/eval/golden.ts — golden-set IO + recall-audit mining. No network.
import { z } from 'zod';

export type QueryClass = 'temporal' | 'proper-noun' | 'conceptual' | 'identifier' | 'cross-repo';

const GoldenSchema = z.object({
  id: z.string(),
  query: z.string(),
  class: z.enum(['temporal', 'proper-noun', 'conceptual', 'identifier', 'cross-repo']),
  entity: z.string().optional(),
  notes: z.string().optional(),
});

export type GoldenEntry = z.infer<typeof GoldenSchema>;

export function parseGolden(jsonl: string): GoldenEntry[] {
  const out: GoldenEntry[] = [];
  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    out.push(GoldenSchema.parse(JSON.parse(t)));
  }
  return out;
}

export function seedFromRecallAudit(jsonl: string, limit: number): { query: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const q = (JSON.parse(t) as { query?: unknown }).query;
      if (typeof q === 'string' && q) counts.set(q, (counts.get(q) ?? 0) + 1);
    } catch { /* skip malformed line */ }
  }
  return [...counts.entries()]
    .map(([query, count]) => ({ query, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
