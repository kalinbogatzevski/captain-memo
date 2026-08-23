import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseCapabilityManifest, renderCapabilitySummary } from '../../src/worker/capability-registry.ts';

test('capability parser exposes names but never executable config or env', () => {
  const home = mkdtempSync(join(tmpdir(), 'captain-cap-parser-'));
  const root = join(home, '.gemini', 'extensions', 'nanobanana');
  mkdirSync(join(root, 'commands'), { recursive: true });
  writeFileSync(join(root, 'commands', 'generate.toml'), 'prompt = "secret executable body"');
  writeFileSync(join(root, 'commands', 'edit.toml'), 'prompt = "edit body"');
  const path = join(root, 'gemini-extension.json');
  const raw = JSON.stringify({
    name: 'nanobanana', version: '1.0.10', description: 'Generate and edit images',
    mcpServers: { nanobanana: { command: 'node', args: ['/private/server.js'], env: { API_KEY: 'top-secret' } } },
  });
  const parsed = parseCapabilityManifest(raw, path);
  expect(parsed).toMatchObject({
    name: 'nanobanana', version: '1.0.10', source_agent: 'gemini', provider: 'gemini-extension',
    operations: ['edit', 'generate'], interfaces: ['mcp:nanobanana'],
  });
  const serialized = JSON.stringify(parsed) + renderCapabilitySummary(parsed);
  expect(serialized).not.toContain('top-secret');
  expect(serialized).not.toContain('/private/server.js');
  expect(serialized).not.toContain('secret executable body');
});
