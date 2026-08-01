// src/worker/theme-judge.ts — wraps the SummarizerTransport into "write ONE theme for this
// cluster, or decline". Mirrors promotion-judge.ts's fail-safe construction.
//
// This is the only component in the consolidation path that GENERATES text, and that asymmetry
// drives every decision here: restoring archived members is a single UPDATE, but a wrong summary
// that a future session reads as fact cannot be un-read. So every ambiguous outcome — transport
// error, unparseable reply, schema mismatch, blank title, explicit decline — resolves to null.
// No theme is written, the members stay exactly as they are, and the next idle pass tries again.
//
// Declining is a first-class answer, not a failure. The finder gathers by cosine, which groups
// things that SOUND alike; only a reader can tell whether they SAY the same thing. A cluster of
// "three stages of building one feature" must come back null.
import { z } from 'zod';
import type { SummarizerTransport } from './summarizer.ts';
import type { ThemeCluster } from './theme-cluster.ts';

export interface ThemeDraft {
  title: string;
  narrative: string;
  facts: string[];
  concepts: string[];
}

const ThemeSchema = z.object({
  theme: z.object({
    title: z.string(),
    narrative: z.string().default(''),
    facts: z.array(z.string()).default([]),
    concepts: z.array(z.string()).default([]),
  }).nullable(),
});

const SYSTEM_PROMPT =
  `You are consolidating a developer's long-term memory. You are given several observations
that a semantic search grouped together because they are worded similarly. They come from
DIFFERENT work sessions, often days or weeks apart.

Decide whether they are all describing ONE durable fact that was learned, re-learned, or
re-confirmed over time. If so, write a single theme that states that fact once, clearly, in
its most current and complete form.

Decline whenever they are NOT one fact. Common cases to decline:
  - successive STAGES of building something (each stage is its own event)
  - superficially similar but materially different facts
  - anything where writing one sentence would lose information a reader needs

Output ONLY a single JSON object, no prose:
{
  "theme": {
    "title": "the durable fact, as a short statement",
    "narrative": "the substance, including what changed across the occurrences",
    "facts": ["specific, checkable statements"],
    "concepts": ["short tags"]
  }
}
To decline, output exactly: {"theme": null}

Declining is a correct and expected answer. Never invent detail the observations do not
contain, and never write a theme that is vaguer than the observations it replaces.`;

function buildUserPrompt(cluster: ThemeCluster): string {
  const lines: string[] = [
    `${cluster.members.length} observations across ${cluster.sessionCount} sessions:`,
  ];
  for (const m of cluster.members) {
    const when = new Date(m.created_at_epoch * 1000).toISOString().slice(0, 10);
    lines.push(`- [${when}] type=${m.type} title="${m.title}"`);
  }
  return lines.join('\n');
}

/** Build the judge: one cluster in, one theme or null out. Never throws. */
export function buildThemeJudge(
  generate: SummarizerTransport,
  opts: { model?: string; maxTokens?: number } = {},
): (cluster: ThemeCluster) => Promise<ThemeDraft | null> {
  return async (cluster: ThemeCluster): Promise<ThemeDraft | null> => {
    if (cluster.members.length === 0) return null;   // never call the model on nothing
    let text: string;
    try {
      const res = await generate({
        model: opts.model ?? 'haiku',
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(cluster),
        max_tokens: opts.maxTokens ?? 1000,
      });
      const block = res.content.find(c => c.type === 'text');
      if (!block) return null;
      text = block.text;
    } catch {
      return null;                                    // offline ⇒ write nothing
    }
    let json: unknown;
    try {
      const match = /\{[\s\S]*\}/.exec(text);         // tolerate prose / code fences around it
      json = JSON.parse(match ? match[0] : text);
    } catch {
      return null;
    }
    const parsed = ThemeSchema.safeParse(json);
    if (!parsed.success || parsed.data.theme === null) return null;
    const t = parsed.data.theme;
    // A blank title is not a decline the model asked for, but it is not a theme either.
    if (t.title.trim().length === 0) return null;
    return { title: t.title.trim(), narrative: t.narrative, facts: t.facts, concepts: t.concepts };
  };
}
