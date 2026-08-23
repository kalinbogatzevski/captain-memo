import type { ChunkInput } from '../../shared/types.ts';
import type { ParsedCapability } from '../capability-registry.ts';
import { renderCapabilitySummary } from '../capability-registry.ts';

export function chunkCapability(capability: ParsedCapability): ChunkInput[] {
  return [{
    text: renderCapabilitySummary(capability),
    position: 0,
    metadata: {
      doc_type: 'capability_summary',
      capability_ref: capability.capability_ref,
      capability_id: capability.capability_id,
      name: capability.name,
      description: capability.description,
      version: capability.version,
      source_agent: capability.source_agent,
      provider: capability.provider,
      operations: capability.operations,
      interfaces: capability.interfaces,
      content_sha: capability.content_sha,
      warnings: capability.warnings,
    },
  }];
}
