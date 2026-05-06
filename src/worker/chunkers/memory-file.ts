import { basename } from 'path';
import type { ChunkInput } from '../../shared/types.ts';

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

  const metadata: Record<string, unknown> = {
    doc_type: 'memory_file',
    filename_id: filenameId,
    source_path: sourcePath,
  };
  if (fields.type) metadata.memory_type = fields.type;
  if (fields.description) metadata.description = fields.description;
  if (fields.name) metadata.name = fields.name;

  return [{
    text: body.trim(),
    position: 0,
    metadata,
  }];
}
