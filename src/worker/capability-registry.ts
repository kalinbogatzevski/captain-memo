import { existsSync, readdirSync, readFileSync } from 'fs';
import { basename, dirname, join, sep } from 'path';
import { sha256Hex } from '../shared/sha.ts';

export type CapabilityProvider = 'gemini-extension' | 'agy-plugin' | 'claude-plugin' | 'codex-plugin' | 'ai-plugin';

export interface ParsedCapability {
  capability_ref: string;
  capability_id: string;
  name: string;
  description: string;
  version: string;
  source_path: string;
  source_agent: string;
  provider: CapabilityProvider;
  operations: string[];
  interfaces: string[];
  content_sha: string;
  warnings: string[];
}

function sourceFromPath(path: string): { agent: string; provider: CapabilityProvider } {
  const p = path.split(sep).join('/').toLowerCase();
  if (p.includes('/.gemini/extensions/')) return { agent: 'gemini', provider: 'gemini-extension' };
  if (p.includes('/.claude/plugins/')) return { agent: 'claude-code', provider: 'claude-plugin' };
  if (p.includes('/.codex/plugins/')) return { agent: 'codex', provider: 'codex-plugin' };
  if (p.includes('/.agents/plugins/')) return { agent: 'agy', provider: 'agy-plugin' };
  return { agent: 'unknown', provider: 'ai-plugin' };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
    : [];
}

function namesIn(dir: string, extensions?: string[]): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || !extensions || extensions.some(ext => entry.name.endsWith(ext)))
      .map(entry => entry.isDirectory() ? entry.name : entry.name.replace(/\.[^.]+$/, ''))
      .filter(name => !name.startsWith('.'));
  } catch { return []; }
}

function safeMcpNames(root: string, manifest: Record<string, unknown>): string[] {
  const direct = manifest.mcpServers;
  const names = direct && typeof direct === 'object' && !Array.isArray(direct)
    ? Object.keys(direct as Record<string, unknown>)
    : [];
  const mcpPath = join(root, '.mcp.json');
  if (existsSync(mcpPath)) {
    try {
      const parsed = JSON.parse(readFileSync(mcpPath, 'utf8')) as { mcpServers?: Record<string, unknown> };
      names.push(...Object.keys(parsed.mcpServers ?? {}));
    } catch { /* malformed companion metadata is non-fatal */ }
  }
  return names;
}

/** Parse only public descriptive fields and safe operation/interface NAMES.
 * Raw manifests, command bodies, args, env and executable content are never
 * returned and therefore can never enter Captain Memo's database or backups. */
export function parseCapabilityManifest(content: string, sourcePath: string): ParsedCapability {
  const raw = JSON.parse(content) as Record<string, unknown>;
  const root = basename(sourcePath) === 'plugin.json' && basename(dirname(sourcePath)) === '.codex-plugin'
    ? dirname(dirname(sourcePath))
    : basename(sourcePath) === 'plugin.json' && basename(dirname(sourcePath)) === '.claude-plugin'
      ? dirname(dirname(sourcePath))
      : dirname(sourcePath);
  const { agent, provider } = sourceFromPath(sourcePath);
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : basename(root);
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const iface = raw.interface && typeof raw.interface === 'object' && !Array.isArray(raw.interface)
    ? raw.interface as Record<string, unknown>
    : {};

  const operations = new Set<string>();
  for (const op of stringList(iface.capabilities)) operations.add(op);
  for (const op of namesIn(join(root, 'commands'), ['.md', '.toml'])) operations.add(op);
  for (const op of namesIn(join(root, 'skills'))) operations.add(op);
  for (const op of namesIn(join(root, 'agents'), ['.md'])) operations.add(`agent:${op}`);

  const interfaces = new Set<string>();
  for (const mcpName of safeMcpNames(root, raw)) interfaces.add(`mcp:${mcpName}`);
  if (typeof raw.skills === 'string' || namesIn(join(root, 'skills')).length > 0) interfaces.add('skills');
  if (typeof raw.apps === 'string') interfaces.add('app');
  if (typeof raw.contextFileName === 'string') interfaces.add('context');

  const sanitized = {
    name, version, description, source_agent: agent, provider,
    operations: [...operations].sort(), interfaces: [...interfaces].sort(),
  };
  const contentSha = sha256Hex(JSON.stringify(sanitized));
  return {
    capability_ref: `${agent}:${name}:${sha256Hex(sourcePath).slice(0, 12)}`,
    capability_id: name,
    name,
    description,
    version,
    source_path: sourcePath,
    source_agent: agent,
    provider,
    operations: sanitized.operations,
    interfaces: sanitized.interfaces,
    content_sha: contentSha,
    warnings: agent === 'unknown' ? ['Unknown owning runtime; verify where this capability can execute.'] : [],
  };
}

export function renderCapabilitySummary(capability: ParsedCapability): string {
  return [
    `Capability: ${capability.name}`,
    capability.description && `Description: ${capability.description}`,
    `Available on: ${capability.source_agent}`,
    capability.version && `Version: ${capability.version}`,
    capability.operations.length && `Operations: ${capability.operations.join(', ')}`,
    capability.interfaces.length && `Interfaces: ${capability.interfaces.join(', ')}`,
    'Execution: delegate to the owning runtime; this descriptor is not executable code.',
  ].filter(Boolean).join('\n');
}
