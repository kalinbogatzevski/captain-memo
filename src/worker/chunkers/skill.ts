import { basename } from 'path';
import type { ChunkInput } from '../../shared/types.ts';
import { splitByH2Sections } from './markdown-sections.ts';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

interface SkillFrontmatter {
  body: string;
  fields: Record<string, string>;
}

function parseFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { body: content, fields: {} };
  const raw = match[1] ?? '';
  const fields: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) fields[key] = value;
  }
  return { body: content.slice(match[0].length), fields };
}

export function chunkSkill(content: string, sourcePath: string): ChunkInput[] {
  const { body, fields } = parseFrontmatter(content);
  const skillId = basename(sourcePath, '.md');
  const description = fields.description ?? '';

  const { intro, sections } = splitByH2Sections(body);

  const chunks: ChunkInput[] = [];
  let position = 0;

  // Skill summary chunk: description + intro paragraph
  const introFirstPara = intro.split(/\n\n/)[0] ?? '';
  if (description || introFirstPara) {
    chunks.push({
      text: [description, introFirstPara].filter(Boolean).join('\n\n'),
      position: position++,
      metadata: {
        doc_type: 'skill_summary',
        skill_id: skillId,
        source_path: sourcePath,
        description,
      },
    });
  }

  // Each ## section as its own chunk
  for (const section of sections) {
    chunks.push({
      text: section.text.trim(),
      position: position++,
      metadata: {
        doc_type: 'skill_section',
        skill_id: skillId,
        source_path: sourcePath,
        section_title: section.title,
        has_code: section.hasCode,
      },
    });
  }

  return chunks;
}
