/**
 * Shared Markdown helpers for chunkers.
 *
 * splitByH2Sections walks the document line by line tracking whether we are
 * inside a triple-backtick code fence — splitting on `## ` lines INSIDE a
 * fence would corrupt the code (and Markdown's spec says the fence wins
 * over heading parsing). The same helper is used by both the skill chunker
 * and the memory-file chunker so they stay in lockstep on edge cases like
 * fenced `## ` examples in skill bodies.
 */

const CODE_FENCE_RE = /^```/;

export interface MarkdownSection {
  title: string;
  text: string;
  hasCode: boolean;
}

export interface H2SplitResult {
  intro: string;
  sections: MarkdownSection[];
}

export function splitByH2Sections(body: string): H2SplitResult {
  const lines = body.split('\n');
  let intro = '';
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | null = null;
  let inFence = false;

  for (const line of lines) {
    if (CODE_FENCE_RE.test(line)) inFence = !inFence;

    // Only split on `## ` when NOT inside a code fence, and reject `### `
    // (more-specific subheadings stay inside their parent H2 section).
    if (!inFence && line.startsWith('## ') && !line.startsWith('### ')) {
      if (current) sections.push(current);
      current = {
        title: line.slice(3).trim(),
        text: line + '\n',
        hasCode: false,
      };
      continue;
    }

    if (current) {
      current.text += line + '\n';
      if (CODE_FENCE_RE.test(line)) current.hasCode = true;
    } else {
      intro += line + '\n';
    }
  }
  if (current) sections.push(current);
  return { intro: intro.trim(), sections };
}
