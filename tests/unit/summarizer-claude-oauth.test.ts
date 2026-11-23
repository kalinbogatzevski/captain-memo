import { test, expect, afterEach } from 'bun:test';
import { createClaudeOauthTransport } from '../../src/worker/summarizer-claude-oauth.ts';

const prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
afterEach(() => {
  if (prevToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
});

const args = { model: 'm', system: 's', user: 'u', max_tokens: 800 };
const okBody = JSON.stringify({ content: [{ type: 'text', text: 'hi' }], model: 'm' });

function fetchSeq(statuses: number[]): { fn: typeof fetch; calls: () => number } {
  let n = 0;
  const fn = (async () => {
    const st = statuses[Math.min(n++, statuses.length - 1)]!;
    return new Response(st === 200 ? okBody : 'denied', { status: st });
  }) as unknown as typeof fetch;
  return { fn, calls: () => n };
}

test('a 401 is retried once with a fresh read; a 200 on the retry succeeds', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
  const f = fetchSeq([401, 200]);
  const r = await createClaudeOauthTransport({ fetchFn: f.fn })(args);
  expect(r.content[0]!.text).toBe('hi');
  expect(f.calls()).toBe(2);
});

test('a 403 twice escapes after exactly one retry', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
  const f = fetchSeq([403]);
  await expect(createClaudeOauthTransport({ fetchFn: f.fn })(args)).rejects.toMatchObject({ status: 403 });
  expect(f.calls()).toBe(2);
});

test('a non-auth error is not retried', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
  const f = fetchSeq([500]);
  await expect(createClaudeOauthTransport({ fetchFn: f.fn })(args)).rejects.toMatchObject({ status: 500 });
  expect(f.calls()).toBe(1);
});
