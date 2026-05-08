import type { EnvelopeHit, ChannelType } from '../shared/types.ts';
import { countTokens, truncateToTokenBudget } from '../shared/tokens.ts';

export interface FormatEnvelopeOptions {
  project_id: string;
  budget_tokens: number;
  hits: EnvelopeHit[];
  degradation_flags: string[];
}

export interface FormatEnvelopeResult {
  envelope: string;
  hit_count: number;
  used_tokens: number;
}

// HEADER instructs the model to ground its answer in the retrieved items
// and to refuse extrapolation. Permissive language ("treat as background
// knowledge") lets the model embellish with plausible-but-unverified
// details — the classic RAG confabulation tail. This wording requires
// explicit grounding and provides an "I don't know" escape path.
const HEADER_LINES = [
  `The following items were retrieved automatically based on the user's most recent prompt.`,
  `The user did NOT see this — they did NOT type these into the conversation.`,
  ``,
  `Use ONLY the information below for facts about this codebase, infrastructure,`,
  `prior decisions, or session history. If the user asks about something not`,
  `covered here, answer with "I don't have specific information about that in`,
  `my retrieved memory" rather than inferring or extrapolating from partial`,
  `matches. Do NOT invent service names, file paths, function names, IPs,`,
  `or other specifics that aren't directly present in the items below.`,
  ``,
  `When you DO use a retrieved item, cite it briefly (e.g., "per session memory").`,
];

function formatScore(score: number): string {
  return score.toFixed(2);
}

function formatObservationDate(epoch: number): string {
  const d = new Date(epoch * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function renderMemoryGroup(hits: EnvelopeHit[]): string {
  if (hits.length === 0) return '';
  const lines: string[] = [`## Local memory (${hits.length} results)`, ''];
  for (const h of hits) {
    const memoryType = String(h.metadata.memory_type ?? 'memory');
    lines.push(`### ${h.title}  ·  ${memoryType}  ·  score ${formatScore(h.score)}`);
    lines.push(h.snippet.trim());
    lines.push(`[full: get_full("${h.doc_id}")]`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderSkillGroup(hits: EnvelopeHit[]): string {
  if (hits.length === 0) return '';
  const lines: string[] = [];
  for (const h of hits) {
    const skillId = String(h.metadata.skill_id ?? 'unknown');
    const sectionTitle = String(h.metadata.section_title ?? '(top)');
    lines.push(`## Skill: ${skillId}  ·  section "${sectionTitle}"  ·  score ${formatScore(h.score)}`);
    lines.push(h.snippet.trim());
    lines.push(`[full: get_full("${h.doc_id}")]`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderObservationGroup(hits: EnvelopeHit[]): string {
  if (hits.length === 0) return '';
  const lines: string[] = [`## Session memory (${hits.length} results)`, ''];
  for (const h of hits) {
    const obsType = String(h.metadata.type ?? h.metadata.field_type ?? 'observation');
    const created = Number(h.metadata.created_at_epoch ?? 0);
    const date = formatObservationDate(created);
    lines.push(`### ${obsType} · ${date} · "${h.title}"`);
    lines.push(h.snippet.trim());
    lines.push(`[full: get_full("${h.doc_id}")]`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Pure formatter. The worker calls this with already-ranked, channel-scoped hits.
 * Token-budget enforcement happens inside this function — bodies are truncated
 * proportional to their share of the budget.
 */
export function formatEnvelope(opts: FormatEnvelopeOptions): FormatEnvelopeResult {
  const { project_id, budget_tokens, hits, degradation_flags } = opts;

  // Group by channel, preserving relative score order within each.
  const byChannel: Record<ChannelType, EnvelopeHit[]> = {
    memory: [], skill: [], observation: [], remote: [],
  };
  for (const h of hits) byChannel[h.channel].push(h);

  // Open + close tag — flags only appear when present (D14).
  const flagAttrs = degradation_flags.length > 0
    ? ` ${degradation_flags.map(f => `flag="${f}"`).join(' ')}`
    : '';
  const openTag = `<memory-context retrieved-by="captain-memo" project="${project_id}" k="${hits.length}" budget-tokens="${budget_tokens}"${flagAttrs}>`;
  const closeTag = `</memory-context>`;

  const headerSection = HEADER_LINES.join('\n');

  // Reserve overhead tokens for tags + header.
  const overheadText = `${openTag}\n${headerSection}\n${closeTag}\n`;
  const overheadTokens = countTokens(overheadText);
  const bodyBudget = Math.max(0, budget_tokens - overheadTokens);

  // Body assembly. Render each group, then if total > body budget, walk
  // back from the last hit's snippet, truncating until we fit.
  let body =
    [renderMemoryGroup(byChannel.memory),
     renderSkillGroup(byChannel.skill),
     renderObservationGroup(byChannel.observation)]
      .filter(s => s.length > 0)
      .join('\n');

  if (countTokens(body) > bodyBudget) {
    body = truncateToTokenBudget(body, bodyBudget);
  }

  const envelope = `${openTag}\n${headerSection}\n\n${body}${body.endsWith('\n') ? '' : '\n'}${closeTag}\n`;
  const used_tokens = Math.min(budget_tokens, countTokens(envelope));

  return { envelope, hit_count: hits.length, used_tokens };
}
