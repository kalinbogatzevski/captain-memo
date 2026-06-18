// src/worker/version-parse.ts — pure version + entity-key parsing for supersede detection.
// Regex-only, no LLM. A title supersedes another iff both parse to clean semver, their
// entityKeys are EXACTLY equal, and their versions differ (compareVersion !== 0). The
// entityKey is the significant tokens of the title with the version span removed, sorted
// and space-joined — so "react 18.0 hooks" and "react 19.0 hooks" share entityKey
// "hooks react" (the cosine confirm in the slice is what keeps genuinely-different facts
// with equal entityKeys apart).
import { significantTokens } from '../shared/title-similarity.ts';

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

// ≥2 numeric components, optional v-prefix; capture any pre-release/build suffix in group 4
// so we can reject it (ambiguous ordering for the conservative slice).
const VERSION_RE = /\bv?(\d+)\.(\d+)(?:\.(\d+))?([-+][\w.]+)?\b/i;

export function parseVersion(title: string): { entityKey: string; version: SemVer } | null {
  const m = VERSION_RE.exec(title);
  if (!m) return null;
  if (m[4]) return null; // pre-release / build suffix → skip
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = m[3] !== undefined ? Number(m[3]) : 0;
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  // Drop the version span before deriving the entity key, so the version digits never
  // pollute it (significantTokens also drops <3-char tokens, so most version debris is
  // already gone, but a clean removal is unambiguous).
  const remainder = `${title.slice(0, m.index)} ${title.slice(m.index + m[0].length)}`;
  const tokens = Array.from(significantTokens(remainder)).sort();
  if (tokens.length === 0) return null;
  return { entityKey: tokens.join(' '), version: { major, minor, patch, raw: m[0] } };
}

export function compareVersion(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}
