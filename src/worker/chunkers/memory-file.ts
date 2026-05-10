import { basename } from 'path';
import type { ChunkInput } from '../../shared/types.ts';
import { splitByH2Sections } from './markdown-sections.ts';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

interface ParsedFrontmatter {
  raw: string;
  body: string;
  fields: Record<string, string>;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { raw: '', body: content, fields: {} };
  }
  const raw = match[1] ?? '';
  const fields: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) fields[key] = value;
  }
  return { raw, body: content.slice(match[0].length), fields };
}

export function chunkMemoryFile(content: string, sourcePath: string): ChunkInput[] {
  const { body, fields } = parseFrontmatter(content);
  const filenameId = basename(sourcePath, '.md');

  const baseMetadata: Record<string, unknown> = {
    doc_type: 'memory_file',
    filename_id: filenameId,
    source_path: sourcePath,
  };
  if (fields.type) baseMetadata.memory_type = fields.type;
  if (fields.description) baseMetadata.description = fields.description;
  if (fields.name) baseMetadata.name = fields.name;

  const { intro, sections } = splitByH2Sections(body);

  // No H2 headings — single-chunk legacy shape (CLAUDE.md-style flat docs,
  // small notes). Preserves embedding behavior for files where there's
  // nothing meaningful to split on.
  if (sections.length === 0) {
    return [{
      text: body.trim(),
      position: 0,
      metadata: baseMetadata,
    }];
  }

  // Multi-section file: emit one chunk per H2 section so each topic gets
  // its own embedding. Sharper retrieval precision (queries match the
  // relevant section, not the whole document) and reduced overflow risk
  // for large memory files. Intro paragraph (before the first heading)
  // becomes its own chunk if non-empty.
  const chunks: ChunkInput[] = [];
  let position = 0;
  if (intro) {
    chunks.push({
      text: intro,
      position: position++,
      metadata: { ...baseMetadata, section_kind: 'intro' },
    });
  }
  for (const section of sections) {
    chunks.push({
      text: section.text.trim(),
      position: position++,
      metadata: {
        ...baseMetadata,
        section_kind: 'h2',
        section_title: section.title,
        ...(section.hasCode && { has_code: true }),
      },
    });
  }
  return chunks;
}
