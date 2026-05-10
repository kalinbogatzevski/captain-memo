import { countTokens } from '../../shared/tokens.ts';
import type { ChunkInput } from '../../shared/types.ts';

/**
 * Multiplier applied to the embedder's nominal max-input-tokens to decide
 * the splitter's target fragment size. The Embedder class already applies
 * its own 0.85 safety factor when validating; using the same value here
 * would mean an off-by-one tokenizer disagreement on the boundary fragment
 * still trips the embedder. Splitting tighter (0.75 of nominal) gives the
 * boundary fragment ~10% of headroom against the embedder's threshold —
 * tokenizer drift between gpt-tokenizer and Voyage stays absorbed.
 */
const SPLIT_TARGET_FRACTION = 0.75;

const HEADING_H2_PREFIX = '## ';
const HEADING_H3_PREFIX = '### ';

/**
 * Split chunks so none exceed the embedder's per-input token limit.
 *
 * Operates on the chunker output BEFORE chunk_ids are assigned, so each
 * resulting fragment becomes a first-class chunk with its own embedding,
 * row, and ID. Preserves all metadata; adds split_index / split_total
 * fields when a chunk gets divided so callers can reconstruct the original
 * if needed (e.g., for observability or for "show full document" UX).
 *
 * Splitting cascade (each level only used if the previous didn't engage
 * or left fragments still too large):
 *   1. H2 headings (`## `)
 *   2. H3 headings (`### `)
 *   3. Blank-line paragraphs
 *   4. Sentence boundaries (. ! ?)
 *   5. Line boundaries (\n)
 *   6. Character-level binary chop (ultimate fallback for one giant line)
 *
 * Positions are renumbered sequentially across the output to maintain
 * ordering invariants downstream (meta store + UI). The original
 * chunk's position is not preserved.
 */
export function splitForEmbed(
  chunks: ChunkInput[],
  limitTokens: number,
): ChunkInput[] {
  const targetTokens = Math.floor(limitTokens * SPLIT_TARGET_FRACTION);
  const out: ChunkInput[] = [];
  let nextPosition = 0;
  for (const chunk of chunks) {
    if (countTokens(chunk.text) <= targetTokens) {
      out.push({ ...chunk, position: nextPosition++ });
      continue;
    }
    const fragments = splitText(chunk.text, targetTokens);
    fragments.forEach((frag, i) => {
      out.push({
        text: frag,
        position: nextPosition++,
        metadata: {
          ...chunk.metadata,
          split_index: i,
          split_total: fragments.length,
        },
      });
    });
  }
  return out;
}

function splitText(text: string, limit: number): string[] {
  const splitters: Array<(s: string) => string[]> = [
    s => splitByHeading(s, HEADING_H2_PREFIX),
    s => splitByHeading(s, HEADING_H3_PREFIX),
    s => splitByParagraph(s),
    s => splitBySentence(s),
    s => splitByLine(s),
  ];
  for (const split of splitters) {
    const parts = split(text);
    if (parts.length <= 1) continue;
    const recursed: string[] = [];
    for (const part of parts) {
      if (countTokens(part) <= limit) {
        recursed.push(part);
      } else {
        recursed.push(...splitText(part, limit));
      }
    }
    return recursed;
  }
  // Last resort — one giant line with no internal structure to split on.
  // Char-level chop preserves coverage at the cost of mid-token cuts.
  return splitByChars(text, limit);
}

function splitByHeading(text: string, marker: string): string[] {
  const lines = text.split('\n');
  const sections: string[][] = [[]];
  for (const line of lines) {
    if (line.startsWith(marker)) {
      sections.push([line]);
    } else {
      sections[sections.length - 1]!.push(line);
    }
  }
  return sections
    .map(s => s.join('\n').trim())
    .filter(Boolean);
}

function splitByParagraph(text: string): string[] {
  return text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
}

function splitBySentence(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

function splitByLine(text: string): string[] {
  return text.split('\n').map(s => s.trim()).filter(Boolean);
}

function splitByChars(text: string, limitTokens: number): string[] {
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (countTokens(remaining) <= limitTokens) {
      out.push(remaining);
      break;
    }
    let lo = 1;
    let hi = remaining.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (countTokens(remaining.slice(0, mid)) <= limitTokens) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    out.push(remaining.slice(0, lo));
    remaining = remaining.slice(lo);
  }
  return out;
}
