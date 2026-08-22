import type { ChunkInput } from '../../shared/types.ts';
import { splitByH2Sections } from './markdown-sections.ts';
import { parseSkillDocument } from '../skill-registry.ts';

export function chunkSkill(content: string, sourcePath: string): ChunkInput[] {
  // Normalize CRLF → LF so the LF-only frontmatter regex matches skill files
  // with Windows line endings (same fix as chunkMemoryFile).
  const skill = parseSkillDocument(content, sourcePath);
  const body = skill.instructions;
  const skillId = skill.skill_id;
  const description = skill.description;

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
        skill_ref: skill.skill_ref,
        skill_name: skill.name,
        source_agent: skill.source_agent,
        source_path: sourcePath,
        description,
        content_sha: skill.content_sha,
        warnings: skill.warnings,
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
        skill_ref: skill.skill_ref,
        skill_name: skill.name,
        source_agent: skill.source_agent,
        source_path: sourcePath,
        description,
        warnings: skill.warnings,
        content_sha: skill.content_sha,
        section_title: section.title,
        has_code: section.hasCode,
      },
    });
  }

  return chunks;
}
