import { test, expect } from 'bun:test';
import { MetaStore } from '../../src/worker/meta.ts';

test('MetaStore keeps sanitized capabilities as first-class rows and cascades deletion', () => {
  const meta = new MetaStore(':memory:');
  const source_path = '/h/.gemini/extensions/nanobanana/gemini-extension.json';
  const document_id = meta.upsertDocument({ source_path, channel: 'capability', project_id: 'p', sha: 'sha', mtime_epoch: 1, metadata: {} });
  meta.upsertCapability({
    document_id, capability_ref: 'gemini:nanobanana:abc', capability_id: 'nanobanana',
    name: 'nanobanana', description: 'Generate images', version: '1.0.10', source_path,
    source_agent: 'gemini', provider: 'gemini-extension', operations: ['generate'],
    interfaces: ['mcp:nanobanana'], content_sha: 'sha', warnings: [],
  });
  expect(meta.getCapabilityByRef('gemini:nanobanana:abc')?.operations).toEqual(['generate']);
  expect(meta.listCapabilities(100, 'gemini')).toHaveLength(1);
  expect(meta.listCapabilities(100, undefined, 'gemini-extension')).toHaveLength(1);
  expect(meta.listCapabilities(100, 'gemini', 'codex-plugin')).toHaveLength(0);
  expect(meta.listCapabilities(100, 'codex')).toHaveLength(0);
  meta.deleteDocument(source_path);
  expect(meta.listCapabilities()).toHaveLength(0);
  meta.close();
});
