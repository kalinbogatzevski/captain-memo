// Pure cross-platform unit test for the Windows embedder installer's command
// construction. Asserts buildVenvCommands() emits the Windows venv layout
// (<venv>\Scripts\, NOT bin/) and bakes in the model id. Runs on Linux CI — no
// shell is spawned, the helper is pure.
import { test, expect } from 'bun:test';
import { buildVenvCommands } from '../../src/services/embedder-installer/powershell.ts';
import type { EmbedderInstallOpts } from '../../src/services/embedder-installer/types.ts';

const OPTS: EmbedderInstallOpts = {
  installDir: 'C:\\Users\\kalin\\.captain-memo\\embed',
  model: 'voyageai/voyage-4-nano',
  port: 8124,
};

test('buildVenvCommands — uses the Windows Scripts\\ venv layout, never bin/', () => {
  const cmds = buildVenvCommands(OPTS);
  const all = cmds.join('\n');
  // Windows venv puts executables under Scripts\, not bin/.
  expect(all).toContain('venv\\Scripts\\python.exe');
  expect(all).not.toContain('/bin/');
  expect(all).not.toContain('venv/bin');
});

test('buildVenvCommands — references the requested model id', () => {
  const cmds = buildVenvCommands(OPTS);
  const all = cmds.join('\n');
  expect(all).toContain('voyageai/voyage-4-nano');
});

test('buildVenvCommands — pre-downloads via SentenceTransformer into models cache', () => {
  const cmds = buildVenvCommands(OPTS);
  const all = cmds.join('\n');
  // HF_HOME points the model cache at <installDir>\models.
  expect(all).toContain('embed\\models');
  expect(all).toContain('HF_HOME');
  expect(all).toContain('SentenceTransformer');
});

test('buildVenvCommands — creates the venv with py -3.11 then a python fallback', () => {
  const cmds = buildVenvCommands(OPTS);
  expect(cmds.some((c) => c.includes('py -3.11 -m venv'))).toBe(true);
  expect(cmds.some((c) => c.includes('python -m venv'))).toBe(true);
});

test('buildVenvCommands — installs requirements.txt with the venv interpreter', () => {
  const cmds = buildVenvCommands(OPTS);
  const all = cmds.join('\n');
  expect(all).toContain('pip install --upgrade pip');
  expect(all).toContain('pip install -r');
  expect(all).toContain('requirements.txt');
});

test('buildVenvCommands — model id flows through verbatim (no hardcoded default)', () => {
  const cmds = buildVenvCommands({ ...OPTS, model: 'voyageai/voyage-4-lite' });
  const all = cmds.join('\n');
  expect(all).toContain('voyageai/voyage-4-lite');
  expect(all).not.toContain('voyage-4-nano');
});
