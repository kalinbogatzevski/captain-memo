// tests/unit/summarizer-login.test.ts — the wizard recommends a summarizer that is logged in on THIS machine.
import { test, expect } from 'bun:test';
import { summarizerLogins, probeSummarizerLogins, type LoginProbeEnv } from '../../src/shared/summarizer-login.ts';
import { AGY_KEYRING_ATTRS, type SecretStoreState } from '../../src/shared/secret-store.ts';

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

test('Codex: auth.json is read from $CODEX_HOME when set (the default folder is then ignored); empty counts as unset; " " is a path, as codex reads it', () => {
  const tokens = '{"tokens":{"id_token":"x"}}';
  const codex = (files: Record<string, string>, codexHome: string) => summarizerLogins(fakeEnv(files, ['codex'], { CODEX_HOME: codexHome })).codex;
  expect(codex({ '/opt/codex-alt/auth.json': tokens }, '/opt/codex-alt')).toBe(true);
  expect(codex({ '/home/u/.codex/auth.json': tokens }, '/opt/codex-alt')).toBe(false);
  expect(codex({ '/home/u/.codex/auth.json': tokens }, '')).toBe(true);
  expect(codex({ '/home/u/.codex/auth.json': tokens }, ' ')).toBe(false);   // codex-cli 0.159.3: "CODEX_HOME points to " ", but that path does not exist"
});

// A keyring-only agy (Linux desktop with a Secret Service, Windows Credential Manager) never writes the token file.
test('agy: the OS keyring answer counts when the token file is absent — present or locked yes, none / unknown no', () => {
  const env = fakeEnv({}, ['agy']);
  expect(summarizerLogins(env, 'unlocked').agy).toBe(true);
  expect(summarizerLogins(env, 'locked').agy).toBe(true);     // the item exists, it is just not readable until the keyring is unlocked
  expect(summarizerLogins(env, 'none').agy).toBe(false);
  expect(summarizerLogins(env, null).agy).toBe(false);        // could not ask
  expect(summarizerLogins(fakeEnv({}, []), 'unlocked').agy).toBe(false);   // agy not installed: a stale keyring item is not a usable summarizer
});

test('probeSummarizerLogins asks the keyring only when agy is installed and its token file is missing', async () => {
  const asked: Array<Readonly<Record<string, string>>> = [];
  const probe = (answer: SecretStoreState | null) => async (attrs: Readonly<Record<string, string>>) => { asked.push(attrs); return answer; };

  expect((await probeSummarizerLogins(fakeEnv({}, ['agy']), probe('unlocked'))).agy).toBe(true);
  expect(asked).toEqual([AGY_KEYRING_ATTRS]);

  asked.length = 0;
  expect((await probeSummarizerLogins(fakeEnv({}, ['agy']), probe('none'))).agy).toBe(false);
  expect((await probeSummarizerLogins(fakeEnv({}, ['agy']), probe(null))).agy).toBe(false);
  expect(asked.length).toBe(2);

  asked.length = 0;
  const withFile = fakeEnv({ '/home/u/.gemini/antigravity-cli/antigravity-oauth-token': 'x' }, ['agy']);
  expect((await probeSummarizerLogins(withFile, probe('none'))).agy).toBe(true);   // the file already answered
  expect((await probeSummarizerLogins(fakeEnv({}, []), probe('unlocked'))).agy).toBe(false);   // agy not installed
  expect(asked).toEqual([]);
});
