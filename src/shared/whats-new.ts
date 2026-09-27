// src/shared/whats-new.ts — the "what's new" lines an upgrade banner shows (#129).
//
// After an update, the SessionStart banner says v<from> → v<to>. These are the headlines of what changed in
// between, read from the CHANGELOG, so the user sees the new features once instead of never. Pure: the worker
// reads the file (GET /whats-new), the hook only formats what comes back.
import { compareSemver } from './self-update.ts';

export interface NewsItem { version: string; text: string }

/** The headline of each change in the CHANGELOG entries after `from`, up to and including `to`, newest first.
 *  A headline is a top-level bullet's bold lead (`- **Homework in top.** …` → "Homework in top"), or its first
 *  sentence when it has none. [Unreleased] and anything outside the range are skipped. */
export function whatsNew(changelog: string, from: string, to: string): NewsItem[] {
  const out: NewsItem[] = [];
  let ver: string | null = null;
  for (const line of String(changelog).split('\n')) {
    const h = /^## \[(\d+\.\d+\.\d+)\]/.exec(line);
    if (h) { ver = compareSemver(h[1]!, from) > 0 && compareSemver(h[1]!, to) <= 0 ? h[1]! : null; continue; }
    if (line.startsWith('## ')) { ver = null; continue; }
    if (!ver || !line.startsWith('- ')) continue;
    const bold = /^- \*\*(.+?)\*\*/.exec(line);
    const text = (bold ? bold[1]! : line.slice(2).split(/(?<=\.)\s/)[0]!).replace(/[.:]\s*$/, '').trim();
    if (text) out.push({ version: ver, text: text.slice(0, 110) });
  }
  return out;
}

export const NEWS_MAX = 5;

/** The banner lines: up to NEWS_MAX headlines, then how many more there are. Empty when there is no news. */
export function newsLines(items: NewsItem[], max: number = NEWS_MAX): string[] {
  if (items.length === 0) return [];
  const multi = new Set(items.map((i) => i.version)).size > 1;
  const lines = ['  What changed:', ...items.slice(0, max).map((i) => `  • ${i.text}${multi ? ` (${i.version})` : ''}`)];
  if (items.length > max) lines.push(`  … and ${items.length - max} more in CHANGELOG.md`);
  return lines;
}
