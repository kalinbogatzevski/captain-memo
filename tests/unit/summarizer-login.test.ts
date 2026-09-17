// tests/unit/summarizer-login.test.ts — the wizard recommends a summarizer that is logged in on THIS machine.
import { test, expect } from 'bun:test';
import { summarizerLogins, type LoginProbeEnv } from '../../src/shared/summarizer-login.ts';

function fakeEnv(files: Record<string, string>, bins: string[], env: Record<string, string> = {}): LoginProbeEnv {
  const norm = (p: string) => p.replaceAll('\\', '/');
  return {
    env, home: '/home/u',
    exists: (p) => norm(p) in files,
    readFile: (p) => files[norm(p)] ?? null,
    which: (b) => bins.includes(b) ? '/usr/bin/' + b : null,
  };
}

test('nothing logged in ⇒ all false (the wizard then warns instead of pretending)', () => {
  expect(summarizerLogins(fakeEnv({}, []))).toEqual({ 'claude-oauth': false, codex: false, agy: false });
});

test('Claude: a creds file with an access token, or the env token, counts; a file without a token does not', () => {
  expect(summarizerLogins(fakeEnv({ '/home/u/.claude/.credentials.json': '{"claudeAiOauth":{"accessToken":"sk-x","expiresAt":1}}' }, []))['claude-oauth']).toBe(true);
  expect(summarizerLogins(fakeEnv({ '/home/u/.claude/.credentials.json': '{"claudeAiOauth":{}}' }, []))['claude-oauth']).toBe(false);
  expect(summarizerLogins(fakeEnv({}, [], { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }))['claude-oauth']).toBe(true);
  expect(summarizerLogins(fakeEnv({ '/home/u/.claude/.credentials.json': 'not json' }, []))['claude-oauth']).toBe(false);
});

test('Codex: needs the binary AND auth.json with an api key or tokens; agy: binary AND its token file', () => {
  const codexAuth = '/home/u/.codex/auth.json';
  expect(summarizerLogins(fakeEnv({ [codexAuth]: '{"tokens":{"id_token":"x"}}' }, ['codex'])).codex).toBe(true);
  expect(summarizerLogins(fakeEnv({ [codexAuth]: '{"OPENAI_API_KEY":"sk"}' }, ['codex'])).codex).toBe(true);
  expect(summarizerLogins(fakeEnv({ [codexAuth]: '{"tokens":{"id_token":"x"}}' }, [])).codex).toBe(false);      // not installed
  expect(summarizerLogins(fakeEnv({}, ['codex'])).codex).toBe(false);                                           // installed, signed out
  expect(summarizerLogins(fakeEnv({ '/home/u/.gemini/antigravity-cli/antigravity-oauth-token': 'x' }, ['agy'])).agy).toBe(true);
  expect(summarizerLogins(fakeEnv({}, ['agy'])).agy).toBe(false);
});
