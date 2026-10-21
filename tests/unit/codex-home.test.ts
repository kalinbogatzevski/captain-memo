// #725 (3): ONE resolution of Codex's home. connect and doctor (cli/cross-ai.ts) and the reader that looks at the same
// folder (the summarizer login probe) both go through shared/codex-home.ts.
import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { codexHomeDir, codexHomeGlobBase, isInCodexHome } from '../../src/shared/codex-home.ts';
import { allMemorySources } from '../../src/shared/ai-memory-sources.ts';
import { allSkillSources } from '../../src/shared/ai-skill-sources.ts';
import { allCapabilitySources } from '../../src/shared/ai-capability-sources.ts';
import { codexHomeDir as viaCrossAi } from '../../src/cli/cross-ai.ts';

const HOME = join(tmpdir(), 'cm-codex-home-fake-home');   // never touched: the helper only builds a path from it

test('codexHomeDir: unset or empty is <home>/.codex, a value is taken as given', () => {
  expect(codexHomeDir(HOME, {})).toBe(join(HOME, '.codex'));
  expect(codexHomeDir(HOME, { CODEX_HOME: '' })).toBe(join(HOME, '.codex'));      // codex reads an empty CODEX_HOME as unset
  expect(codexHomeDir(HOME, { CODEX_HOME: join(HOME, 'alt') })).toBe(join(HOME, 'alt'));
});

test('codexHomeDir: a whitespace-only CODEX_HOME is a path, not unset (codex-cli 0.159.3 refuses to start on " ")', () => {
  expect(codexHomeDir(HOME, { CODEX_HOME: ' ' })).toBe(' ');
});

test('cross-ai.ts exports the very same function (doctor and connect import it from there)', () => {
  expect(viaCrossAi).toBe(codexHomeDir);
});

// The summarizer login probe used to carry its own copy of the resolution (with a different idea of "empty").
// Behaviour is pinned by its own test; this stops the copy coming back.
test('the summarizer login probe does not resolve CODEX_HOME on its own', () => {
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'shared', 'summarizer-login.ts'), 'utf-8');
  expect(src).not.toMatch(/\.CODEX_HOME\b/);
  expect(src).toContain('codexHomeDir(');
});

// The other readers of the codex folder go through the same helper too.
test('the capture reader, the skill refresh and the plugin discovery do not resolve CODEX_HOME on their own', () => {
  for (const rel of [
    ['src', 'worker', 'capture', 'codex-source.ts'],
    ['src', 'cli', 'skill-refresh.ts'],
    ['src', 'shared', 'ai-capability-sources.ts'],
  ]) {
    const src = readFileSync(join(import.meta.dir, '..', '..', ...rel), 'utf-8');
    expect(src, rel.join('/')).not.toMatch(/\.CODEX_HOME\b/);
    expect(src, rel.join('/')).toContain('codexHomeDir(');
  }
});

test('codexHomeGlobBase: the default keeps the literal <home>/.codex the globs always had, a CODEX_HOME is used as given', () => {
  expect(codexHomeGlobBase(HOME, {})).toBe(`${HOME}/.codex`);
  expect(codexHomeGlobBase(HOME, { CODEX_HOME: '' })).toBe(`${HOME}/.codex`);
  expect(codexHomeGlobBase(HOME, { CODEX_HOME: join(HOME, '.codex') })).toBe(`${HOME}/.codex`);   // the default, spelled out
  expect(codexHomeGlobBase(HOME, { CODEX_HOME: join(HOME, 'alt') })).toBe(join(HOME, 'alt'));
});

test('isInCodexHome: inside the effective home only, with either separator', () => {
  const alt = join(HOME, 'alt');
  expect(isInCodexHome(join(alt, 'skills', 'x', 'SKILL.md'), HOME, { CODEX_HOME: alt })).toBe(true);
  expect(isInCodexHome(`${alt.replace(/\\/g, '/')}/AGENTS.md`, HOME, { CODEX_HOME: alt })).toBe(true);
  expect(isInCodexHome(join(HOME, '.codex', 'AGENTS.md'), HOME, { CODEX_HOME: alt })).toBe(false);   // codex ignores ~/.codex once CODEX_HOME is set
  expect(isInCodexHome(join(HOME, '.codex', 'AGENTS.md'), HOME, {})).toBe(true);
  expect(isInCodexHome(alt + '-other/AGENTS.md', HOME, { CODEX_HOME: alt })).toBe(false);            // a sibling that merely shares the prefix
});

// HARD RULE (AGENTS.md): memory files are .md/.mdc only, so credentials and session logs are STRUCTURALLY unindexable. CODEX_HOME can point
// anywhere, including a folder that holds auth.json and sessions/**.jsonl. This lays one out, then asks every discovery glob (memory, skills,
// capabilities) with the same Bun.Glob matcher the watcher filters events with which of its files it would index.
test('a CODEX_HOME holding credentials and session logs: discovery indexes its markdown / SKILL.md / plugin.json and nothing else', () => {
  const home = mkdtempSync(join(tmpdir(), 'cm-codex-home-disc-'));
  try {
    const ch = join(home, 'codex-alt');
    const put = (rel: string): string => { const p = join(ch, ...rel.split('/')); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, 'x'); return p; };
    const indexed = ['memories/m.md', 'AGENTS.md', 'skills/s/SKILL.md', 'skills/.system/t/SKILL.md', 'plugins/cache/mp/pl/1.0/.codex-plugin/plugin.json'].map(put);
    const never = ['auth.json', 'config.toml', 'history.jsonl', 'state.sqlite', 'sessions/2026/10/21/rollout-x.jsonl', 'memories/key.json',
      'skills/s/token.json', 'skills/s/notes.md', 'plugins/cache/mp/pl/1.0/.codex-plugin/secrets.json'].map(put);
    const env = { CODEX_HOME: ch };
    const globs = [...allMemorySources(env), ...allSkillSources(home, env), ...allCapabilitySources(home, env)]
      .map((s) => new Bun.Glob(s.glob.replace(/\\/g, '/')));
    const files = (readdirSync(ch, { recursive: true }) as string[]).map((r) => join(ch, r)).filter((p) => statSync(p).isFile());
    const reached = files.filter((f) => globs.some((g) => g.match(f.replace(/\\/g, '/'))));
    expect(reached.sort()).toEqual(indexed.sort());
    for (const f of never) expect(reached).not.toContain(f);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
