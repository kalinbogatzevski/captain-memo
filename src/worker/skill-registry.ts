import { basename, dirname } from 'path';
import { sha256Hex } from '../shared/sha.ts';
import { skillToolFromPath } from '../shared/ai-skill-sources.ts';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

export interface ParsedSkill {
  skill_ref: string;
  skill_id: string;
  name: string;
  description: string;
  instructions: string;
  raw_content: string;
  source_path: string;
  source_agent: string;
  content_sha: string;
  frontmatter: Record<string, string>;
  warnings: string[];
}

/** Small, dependency-free YAML-frontmatter reader for Agent Skills' scalar
 * fields. It intentionally does not pretend to parse arbitrary YAML; unknown
 * nested fields remain in raw_content for lossless export and loading. */
export function parseSkillFrontmatter(content: string): {
  body: string;
  fields: Record<string, string>;
} {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(FRONTMATTER_RE);
  if (!match) return { body: normalized, fields: {} };

  const fields: Record<string, string> = {};
  const lines = (match[1] ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const scalar = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!scalar) continue;
    const key = scalar[1]!;
    let value = scalar[2]!.trim();
    if (/^[>|][-+]?\s*$/.test(value)) {
      const folded = value.startsWith('>');
      const parts: string[] = [];
      while (i + 1 < lines.length && /^(?:\s+|\s*$)/.test(lines[i + 1]!)) {
        const next = lines[++i]!;
        parts.push(next.trim());
      }
      value = folded ? parts.join(' ').replace(/\s+/g, ' ').trim() : parts.join('\n').trim();
    }
    fields[key] = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return { body: normalized.slice(match[0].length), fields };
}

function skillIdFromPath(sourcePath: string): string {
  return basename(sourcePath).toLowerCase() === 'skill.md'
    ? basename(dirname(sourcePath))
    : basename(sourcePath, '.md');
}

function portabilityWarnings(body: string, fields: Record<string, string>, sourceAgent: string): string[] {
  const warnings: string[] = [];
  if (sourceAgent === 'claude-code' && (
    fields.context === 'fork' || /\$\{CLAUDE_[A-Z_]+\}|!`[^`]+`|\bhooks?:/m.test(body)
  )) warnings.push('Contains Claude Code-specific runtime features; apply them only when supported.');
  if (/agents\/openai\.ya?ml|\.codex\//i.test(body)) {
    warnings.push('Contains Codex-specific paths or metadata; translate them for other CLIs.');
  }
  return warnings;
}

export function parseSkillDocument(content: string, sourcePath: string): ParsedSkill {
  const rawContent = content.replace(/\r\n/g, '\n');
  const { body, fields } = parseSkillFrontmatter(rawContent);
  const fallbackId = skillIdFromPath(sourcePath);
  const skillId = (fields.name || fallbackId).trim();
  const sourceAgent = skillToolFromPath(sourcePath);
  return {
    skill_ref: `${sourceAgent}:${skillId}:${sha256Hex(sourcePath).slice(0, 12)}`,
    skill_id: skillId,
    name: skillId,
    description: (fields.description ?? '').trim(),
    instructions: body.trim(),
    raw_content: rawContent,
    source_path: sourcePath,
    source_agent: sourceAgent,
    content_sha: sha256Hex(rawContent),
    frontmatter: fields,
    warnings: portabilityWarnings(body, fields, sourceAgent),
  };
}
