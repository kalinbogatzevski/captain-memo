import { redactSecrets } from '../shared/redact-secrets.ts';
import type { EnvelopeHit, ChannelType } from '../shared/types.ts';
import { countTokens, countTokensUpTo, truncateToTokenBudget } from '../shared/tokens.ts';

/** Per-hit snippet token caps; absent = the whole snippet. */
type Caps = Map<EnvelopeHit, number>;

export interface FormatEnvelopeOptions {
  project_id: string;
  budget_tokens: number;
  hits: EnvelopeHit[];
  degradation_flags: string[];
  /** Each snippet is cut to this many chars after redaction, before it is tokenized: index.ts passes a credential-shaped
   *  chunk whole (so no secret is cut before it is redacted), and the tokenizer is superlinear on a long run of one
   *  letter (40 000 chars: 31 s, blocking the worker). The same cap the other snippets were cut to. Absent: no cut. */
  snippet_chars?: number;
}

export interface FormatEnvelopeResult {
  envelope: string;
  /** rendered_ids.length — the envelope's k= too. */
  hit_count: number;
  used_tokens: number;
  /** doc_ids of the hits in front of the model, in input order: over budget the lowest-ranked are dropped WHOLE.
   *  Only these may be counted, audited or bumped — a hit the model never saw was not recalled. */
  rendered_ids: string[];
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

function renderMemoryGroup(hits: EnvelopeHit[], caps?: Caps): string {
  if (hits.length === 0) return '';
  const lines: string[] = [`## Local memory (${hits.length} results)`, ''];
  for (const h of hits) {
    const memoryType = String(h.metadata.memory_type ?? 'memory');
    lines.push(`### ${h.title}  ·  ${memoryType}  ·  score ${formatScore(h.score)}`);
    lines.push(safeSnippet(h, caps?.get(h)));
    lines.push(`[full: get_full("${h.doc_id}")]`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderSkillGroup(hits: EnvelopeHit[], caps?: Caps): string {
  if (hits.length === 0) return '';
  const lines: string[] = [];
  for (const h of hits) {
    const skillId = String(h.metadata.skill_id ?? 'unknown');
    const sectionTitle = String(h.metadata.section_title ?? '(top)');
    lines.push(`## Skill: ${skillId}  ·  section "${sectionTitle}"  ·  score ${formatScore(h.score)}`);
    lines.push(safeSnippet(h, caps?.get(h)));
    lines.push(`[full: get_full("${h.doc_id}")]`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderSavingsBadge(
  workTokens: number,
  readTokens: number,
  opts: { percent: boolean; amount: boolean; work: boolean; read: boolean },
): string | null {
  if (workTokens <= 0) return null;
  const saved = Math.max(0, workTokens - readTokens);
  const pct = Math.max(0, Math.min(100, Math.round((saved / workTokens) * 100)));
  const parts: string[] = [];
  if (opts.percent) parts.push(`saved ${pct}%`);
  if (opts.amount) parts.push(`${saved.toLocaleString()} tokens saved`);
  if (opts.work) parts.push(`work ${workTokens.toLocaleString()}`);
  if (opts.read) parts.push(`recall ${readTokens.toLocaleString()}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function renderObservationGroup(hits: EnvelopeHit[], caps?: Caps): string {
  if (hits.length === 0) return '';

  const showPercent = process.env.CAPTAIN_MEMO_SHOW_SAVINGS_PERCENT !== '0';
  const showAmount = process.env.CAPTAIN_MEMO_SHOW_SAVINGS_AMOUNT === '1';
  const showWork = process.env.CAPTAIN_MEMO_SHOW_WORK_TOKENS === '1';
  const showRead = process.env.CAPTAIN_MEMO_SHOW_READ_TOKENS === '1';
  const anyBadge = showPercent || showAmount || showWork || showRead;

  const lines: string[] = [`## Session memory (${hits.length} results)`, ''];
  for (const h of hits) {
    const obsType = String(h.metadata.type ?? h.metadata.field_type ?? 'observation');
    const created = Number(h.metadata.created_at_epoch ?? 0);
    const date = formatObservationDate(created);

    // Build the rendered hit block first so we can count its true token cost
    // (header + snippet + trailer), not just the snippet alone.
    const renderedLines = [
      `### ${obsType} · ${date} · "${h.title}"`,
      safeSnippet(h, caps?.get(h)),
      `[full: get_full("${h.doc_id}")]`,
    ];
    const readTokens = anyBadge ? countTokens(renderedLines.join('\n')) : 0;

    lines.push(...renderedLines);

    if (anyBadge) {
      const workTokens = typeof h.metadata.work_tokens === 'number' ? h.metadata.work_tokens : null;
      if (workTokens !== null && workTokens > 0) {
        const badge = renderSavingsBadge(workTokens, readTokens, {
          percent: showPercent,
          amount: showAmount,
          work: showWork,
          read: showRead,
        });
        if (badge) lines.push(badge);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Inbox surfacing (B1 §7): a compact summary line + ≤N bodies from the fleet,
// rendered AHEAD of recall so a directed message isn't buried below semantic hits.
// Inbox hits are tagged metadata.inbox=true and carry NO observation_id (bump-exempt).
// The summary hit (metadata.inbox_summary=true) renders its title verbatim — it already
// holds the "📨 K unread …" line; body hits render sender + short timestamp + body.
function renderInboxGroup(hits: EnvelopeHit[]): string {
  if (hits.length === 0) return '';
  const lines: string[] = [];
  for (const h of hits) {
    if (h.metadata.inbox_summary === true) {
      lines.push(h.title, '');
      continue;
    }
    const from = String(h.metadata.from ?? 'peer');
    const when = String(h.metadata.when ?? '');
    lines.push(`### 📨 ${from}${when ? ` · ${when}` : ''}`);
    lines.push(h.snippet.trim());
    lines.push('');
  }
  return lines.join('\n');
}

function renderRemoteGroup(hits: EnvelopeHit[], caps?: Caps): string {
  if (hits.length === 0) return '';
  const lines: string[] = [`## Remote memory — from connected Captains (${hits.length} results)`, ''];
  for (const h of hits) {
    const peerLabel = String(h.metadata.origin_label ?? h.metadata.origin_peer ?? 'peer');
    const originChannel = String(h.metadata.origin_channel ?? 'memory');
    lines.push(`### ⚓ ${peerLabel} · ${originChannel} · "${h.title}" · score ${formatScore(h.score)}`);
    lines.push(safeSnippet(h, caps?.get(h)));
    // No get_full link: a remote doc_id isn't resolvable against the LOCAL corpus
    // in Stage 1 — the snippet is the payload. Cross-link drill is a later stage.
    lines.push('');
  }
  return lines.join('\n');
}

// fitGroup renders the same snippet at the same cap again and again (the bisect, the slack loop) and the redaction and
// the tokenizer are the cost, so formatEnvelope — synchronous — memoizes them for the length of one call.
// Cost (2026-09-28, credential-bearing snippets, so each comes in as its whole chunk; before → after): 5 × 20 KB at
// 4 000 tokens 134-162 → 125-152 ms, at 400 37-41 → 18-24; 50 × 3 KB at 4 000 115-120 → 94-118, at 400 77-132 → 65-93
// (redactSecrets calls 213 → 104); 15 × 100 KB at 4 000 348-391 → 273-320. What is left is truncateToTokenBudget's
// bisect over each whole chunk, once per cap: the same 5 hits pre-cut to 2 880 chars take 12-18 ms.
let snippetMemo: Map<EnvelopeHit, Map<number | undefined, string>> | null = null;
/** opts.snippet_chars, for the formatEnvelope call in progress. */
let snippetChars: number | undefined;

/** redactAndCut, memoized for the formatEnvelope call in progress. */
function safeSnippet(h: EnvelopeHit, maxTokens?: number): string {
  const per = snippetMemo?.get(h);
  const known = per?.get(maxTokens);
  if (known !== undefined) return known;
  const s = redactAndCut(h, maxTokens);
  if (snippetMemo) { if (per) per.set(maxTokens, s); else snippetMemo.set(h, new Map([[maxTokens, s]])); }
  return s;
}

/** The snippet as injected: credential-shaped values redacted (shared/redact-secrets.ts), then cut to `maxTokens`.
 *  Auto-recall once put a full GitLab API token into an unrelated session by fuzzy match; get_full — an explicit
 *  ask for that one document — is the way to read the real value, and it says so. */
function redactAndCut(h: EnvelopeHit, maxTokens?: number): string {
  const r = redactSecrets(h.snippet.trim());
  // Cut AFTER redaction: a secret cut mid-way no longer matches its pattern and would leak its prefix.
  const capped = snippetChars === undefined ? r.text : r.text.slice(0, snippetChars);
  const text = maxTokens === undefined ? capped : truncateToTokenBudget(capped, maxTokens);
  return r.count ? `${text}
(${r.count} credential-shaped value${r.count === 1 ? '' : 's'} redacted — get_full("${h.doc_id}") for the document)` : text;
}

const join = (...parts: string[]) => parts.filter(s => s.length > 0).join('\n');

/** Water-fill `budget` tokens over `sizes`: a hit needing less than an equal share keeps all of it, and what it
 *  leaves goes to the longer ones. */
function fairShares(sizes: number[], budget: number): number[] {
  const shares = sizes.map(() => 0);
  let left = Math.max(0, budget);
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[a]! - sizes[b]!);
  order.forEach((i, k) => {
    shares[i] = Math.min(sizes[i]!, Math.floor(left / (order.length - k)));
    left -= shares[i]!;
  });
  return shares;
}

/** Keep the leading `items` whose chrome — `render` with every snippet cut to 0 (header, marker, get_full line) —
 *  fits `budget` (the rest are dropped WHOLE), and water-fill what the chrome leaves over their snippets. Caps only
 *  the snippets that must be cut. */
function fitGroup(items: EnvelopeHit[], budget: number, render: (kept: EnvelopeHit[], caps: Caps) => string,
  size: Map<EnvelopeHit, number>): { kept: EnvelopeHit[]; caps: Caps } {
  const chrome = (k: EnvelopeHit[]) => countTokens(render(k, new Map(k.map(h => [h, 0]))));
  let kept = items;
  let c = chrome(kept);
  if (c > budget) {
    // Bisect the kept count. Should BPE across the joins make the count non-monotone, fewer may be kept than would
    // fit, never more: each kept count was measured.
    let lo = 0, hi = items.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (chrome(items.slice(0, mid)) <= budget) lo = mid; else hi = mid - 1; }
    kept = items.slice(0, lo); c = chrome(kept);
  }
  const shares = fairShares(kept.map(h => size.get(h)!), budget - c);
  return { kept, caps: new Map(kept.flatMap((h, i): [EnvelopeHit, number][] => (shares[i]! < size.get(h)! ? [[h, shares[i]!]] : []))) };
}

/**
 * Pure formatter. The worker calls this with already-ranked, channel-scoped hits.
 * Token-budget enforcement happens inside this function: over budget, the snippets of the hits that won a slot are
 * water-filled over what their headers leave; a hit whose header does not fit is dropped whole, lowest-ranked
 * first. The result names exactly what rendered.
 */
export function formatEnvelope(opts: FormatEnvelopeOptions): FormatEnvelopeResult {
  snippetMemo = new Map();
  snippetChars = opts.snippet_chars;
  try { return renderEnvelope(opts); } finally { snippetMemo = null; snippetChars = undefined; }
}

/** A heading or an observation title can carry a token as well as a snippet: titles are redacted once, up front.
 *  Cost (2026-09-29, README.md slices, median of 31): 50 hits at 4 000 tokens 71 → 75 ms, at 400 19 → 20; 5 hits within noise. */
function redactTitles(h: EnvelopeHit): EnvelopeHit {
  const clean = (v: unknown) => redactSecrets(String(v)).text;
  const m = h.metadata;
  return { ...h, title: clean(h.title), metadata: { ...m,
    ...(m.section_title != null && { section_title: clean(m.section_title) }),
    ...(m.origin_label != null && { origin_label: clean(m.origin_label) }) } };
}

function renderEnvelope(opts: FormatEnvelopeOptions): FormatEnvelopeResult {
  const { project_id, budget_tokens, degradation_flags } = opts;
  const hits = opts.hits.map(h => (h.metadata.inbox === true ? h : redactTitles(h)));

  // Inbox hits (B1 §7) are surfaced ahead of recall and rendered separately; pull
  // them out of channel grouping by their metadata.inbox marker so they never mix
  // into "Local memory". They carry no observation_id → already retrieval-bump-exempt.
  const inboxHits = hits.filter(h => h.metadata.inbox === true);
  // Recall in rank order (the input order). A capability hit has no group: it never renders, so it is not counted.
  const recall = hits.filter(h => h.metadata.inbox !== true && h.channel !== 'capability');

  // Open + close tag — flags only appear when present (D14). k= counts what rendered, so the tag is built last;
  // the reserve assumes every hit renders (the widest k).
  const flagAttrs = degradation_flags.length > 0
    ? ` ${degradation_flags.map(f => `flag="${f}"`).join(' ')}`
    : '';
  const headerSection = HEADER_LINES.join('\n');
  const wrap = (k: number, body: string) =>
    `<memory-context retrieved-by="captain-memo" project="${project_id}" k="${k}" budget-tokens="${budget_tokens}"${flagAttrs}>\n`
    + `${headerSection}\n\n${body}${body.endsWith('\n') ? '' : '\n'}</memory-context>\n`;
  const bodyBudget = Math.max(0, budget_tokens - countTokens(wrap(hits.length, '')));

  // Body assembly: inbox first, then the recall groups in their fixed order, each keeping the rank order.
  const inboxText = renderInboxGroup(inboxHits);
  const render = (kept: EnvelopeHit[], caps?: Caps) => {
    const of = (c: ChannelType) => kept.filter(h => h.channel === c);
    return join(inboxText, renderMemoryGroup(of('memory'), caps), renderSkillGroup(of('skill'), caps),
      renderObservationGroup(of('observation'), caps), renderRemoteGroup(of('remote'), caps));
  };

  let kept = recall;
  let body = render(kept);
  if (countTokensUpTo(body, bodyBudget) > bodyBudget) {
    // Over budget. A plain cut from the end took the LAST group first, so an observation that won a top_k slot
    // (Session memory renders last) vanished while k=, the recall audit and the from_auto bump still counted it;
    // dense text (Bulgarian, ~2 chars/token) lost the whole group.
    // Cost (2026-09-28, cold tokenizer, vs that single cut — the tokenizer is all of it): the repro (1 observation + 4
    // dense Bulgarian 2 880-char hits) at 4 000 tokens 106-114 ms (was 118-130), at 400 41-46 (57-109); top_k 50 of
    // dense 600-char hits at 4 000 150-177 (148-153), at 400 63-112 (91-143). Under budget this block does not run.
    const size = new Map(recall.map(h => [h, countTokensUpTo(safeSnippet(h), bodyBudget)]));
    // Token counts are not additive across the joins: a fit that still overflows is redone with the overflow held back.
    for (let slack = 0; ;) {
      const fit = fitGroup(recall, bodyBudget - slack, render, size);
      kept = fit.kept;
      body = render(kept, fit.caps);
      const over = countTokens(wrap(inboxHits.length + kept.length, body)) - budget_tokens;
      if (over <= 0) break;
      // Nothing left to drop — a budget below the header alone: cut what is left, as before.
      if (kept.length === 0) { body = truncateToTokenBudget(body, countTokens(body) - over); break; }
      slack += over;
    }
  }

  // Only what rendered is counted (k=, hit_count), audited or bumped: a hit the model never saw was not recalled.
  // ponytail: inbox hits (none on this edition) count as rendered, as before; only recall is fitted.
  const rendered = hits.filter(h => h.metadata.inbox === true || kept.includes(h));
  const envelope = wrap(rendered.length, body);
  const used_tokens = Math.min(budget_tokens, countTokens(envelope));

  return { envelope, hit_count: rendered.length, used_tokens, rendered_ids: rendered.map(h => h.doc_id) };
}
