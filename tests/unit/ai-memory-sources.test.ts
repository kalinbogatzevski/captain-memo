import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { allMemorySources, discoverMemoryGlobs, probeDir, toolFromPath } from '../../src/shared/ai-memory-sources.ts';

// ─── The two invariants. These are the whole safety story for `auto`. ───

test('INVARIANT: every glob contains a wildcard', () => {
  // Bun.Glob.scan() returns ZERO hits for a wildcard-free absolute path even when
  // the file exists — a literal path here would silently index nothing at all.
  for (const s of allMemorySources()) {
    expect(s.glob).toContain('*');
  }
});

test('INVARIANT: every glob ends in .md or .mdc — this is what keeps secrets out', () => {
  // Structural, not a blocklist. These sit in the very directories we glob:
  //   ~/.codex/auth.json, ~/.gemini/oauth_creds.json, ~/.gemini/google_accounts.json
  //   ~/.codex/sessions/**.jsonl (53 MB of transcripts), ~/.codex/*.sqlite
  // The extension gate makes every one of them unreachable. If this test ever fails,
  // a credential file or a session-log firehose just became indexable.
  for (const s of allMemorySources()) {
    expect(s.glob.endsWith('.md') || s.glob.endsWith('.mdc')).toBe(true);
  }
});

test('no glob reaches into a known secret or session-log location', () => {
  const forbidden = ['auth.json', 'oauth_creds', 'google_accounts', 'sessions/', 'history.jsonl', '.sqlite', 'config.toml'];
  for (const s of allMemorySources()) {
    for (const bad of forbidden) {
      expect(s.glob).not.toContain(bad);
    }
  }
});

test('discoverMemoryGlobs returns a deduped subset of the table', () => {
  const all = new Set(allMemorySources().map(s => s.glob));
  const found = discoverMemoryGlobs();
  expect(new Set(found).size).toBe(found.length);       // deduped
  for (const g of found) expect(all.has(g)).toBe(true); // subset — never invents a path
});

test('toolFromPath maps each assistant to its provenance tag', () => {
  const H = process.env.HOME ?? '/home/x';
  expect(toolFromPath(`${H}/.codex/memories/a.md`)).toBe('codex');
  expect(toolFromPath(`${H}/.gemini/GEMINI.md`)).toBe('gemini');
  expect(toolFromPath(`${H}/.cursor/rules/x.md`)).toBe('cursor');
  expect(toolFromPath(`${H}/.claude/projects/p/memory/m.md`)).toBe('claude');
  expect(toolFromPath('/repo/.github/copilot-instructions.md')).toBe('copilot');
  expect(toolFromPath('/repo/AGENTS.md')).toBe('agents');
  expect(toolFromPath('/repo/CLAUDE.md')).toBe('claude');
  expect(toolFromPath('/repo/GEMINI.md')).toBe('gemini');
  expect(toolFromPath('/repo/rules/x.mdc')).toBe('cursor');
  expect(toolFromPath('/somewhere/random.md')).toBe('other');
});

test('REGRESSION: probeDir handles a wildcard in the FILENAME, not just a directory', () => {
  // The naive "everything before the first *" gives '/a/b/CLAUDE' — not a path, so
  // existsSync is always false and the glob is silently dropped. That is precisely
  // how ~/.claude/CLAUDE.md (the user's global instructions) went un-indexed.
  expect(probeDir('/a/b/CLAUDE*.md')).toBe('/a/b');
  expect(probeDir('/a/b/AGENTS*.md')).toBe('/a/b');
  // A wildcard at a directory boundary keeps the directory itself.
  expect(probeDir('/a/b/*/memory/*.md')).toBe('/a/b/');
  expect(probeDir('/a/b/*/CLAUDE.md')).toBe('/a/b/');
});

test('REGRESSION: a filename-wildcard glob is actually discovered when its dir exists', () => {
  // End-to-end guard on the same bug: every table row whose directory exists must
  // survive discovery, including the CLAUDE*.md / AGENTS*.md / GEMINI*.md shapes.
  const { existsSync } = require('fs');
  const found = new Set(discoverMemoryGlobs());
  for (const s of allMemorySources()) {
    if (existsSync(probeDir(s.glob))) expect(found.has(s.glob)).toBe(true);
  }
});

test('codex memory globs follow $CODEX_HOME (replacing ~/.codex) and its files are tagged codex', () => {
  const codexGlobs = (env: Record<string, string>) => allMemorySources(env).filter((s) => s.tool === 'codex').map((s) => s.glob);
  const H = process.env.HOME ?? '/home/x';
  expect(codexGlobs({})).toEqual([`${H}/.codex/memories/*.md`, `${H}/.codex/AGENTS*.md`]);
  expect(codexGlobs({ CODEX_HOME: '' })).toEqual(codexGlobs({}));                   // blank = unset

  const alt = mkdtempSync(join(tmpdir(), 'cm-memory-codex-alt-'));
  try {
    mkdirSync(join(alt, 'memories'));
    expect(codexGlobs({ CODEX_HOME: alt })).toEqual([`${alt}/memories/*.md`, `${alt}/AGENTS*.md`]);
    expect(discoverMemoryGlobs({ CODEX_HOME: alt })).toEqual(expect.arrayContaining([`${alt}/memories/*.md`, `${alt}/AGENTS*.md`]));
    expect(discoverMemoryGlobs({ CODEX_HOME: alt })).not.toContain(`${H}/.codex/memories/*.md`);
    expect(toolFromPath(join(alt, 'memories', 'a.md'), { CODEX_HOME: alt })).toBe('codex');
    expect(toolFromPath(join(alt, 'AGENTS.md'), { CODEX_HOME: alt })).toBe('codex');   // not 'agents'
    expect(toolFromPath(join(alt, 'AGENTS.md'), {})).toBe('agents');
  } finally { rmSync(alt, { recursive: true, force: true }); }
});
