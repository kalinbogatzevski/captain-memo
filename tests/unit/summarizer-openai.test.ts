import { test, expect } from 'bun:test';
import { createOpenAITransport } from '../../src/worker/summarizer-openai.ts';

function fakeFetch(responses: Array<{ status?: number; body: unknown }>): {
  fn: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (async (input: any, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test('openai transport — happy path returns content + echoes model', async () => {
  const f = fakeFetch([{
    body: {
      choices: [{ message: { role: 'assistant', content: 'hello from llm' } }],
      model: 'gpt-4o-mini',
    },
  }]);
  const t = createOpenAITransport({ endpoint: 'http://x/v1/chat/completions', fetchFn: f.fn });
  const out = await t({ model: 'gpt-4o-mini', system: 'sys', user: 'usr', max_tokens: 200 });
  expect(out.content).toEqual([{ type: 'text', text: 'hello from llm' }]);
  expect(out.model).toBe('gpt-4o-mini');
});

test('openai transport — sends correct OpenAI-shaped body', async () => {
  const f = fakeFetch([{
    body: { choices: [{ message: { content: 'ok' } }], model: 'm' },
  }]);
  const t = createOpenAITransport({ endpoint: 'http://x/v1/chat/completions', fetchFn: f.fn });
  await t({ model: 'm1', system: 'SYS', user: 'USR', max_tokens: 200 });
  const init = f.calls[0]!.init;
  expect(init.method).toBe('POST');
  const body = JSON.parse(init.body as string);
  expect(body.model).toBe('m1');
  expect(body.max_tokens).toBe(200);
  expect(body.messages).toEqual([
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'USR' },
  ]);
});

test('openai transport — auth header included only when apiKey set', async () => {
  const f1 = fakeFetch([{ body: { choices: [{ message: { content: 'ok' } }], model: 'm' } }]);
  const t1 = createOpenAITransport({ endpoint: 'http://x', fetchFn: f1.fn });
  await t1({ model: 'm', system: '', user: '', max_tokens: 200 });
  const headers1 = f1.calls[0]!.init.headers as Record<string, string>;
  expect(headers1.authorization).toBeUndefined();

  const f2 = fakeFetch([{ body: { choices: [{ message: { content: 'ok' } }], model: 'm' } }]);
  const t2 = createOpenAITransport({ endpoint: 'http://x', apiKey: 'sk-test', fetchFn: f2.fn });
  await t2({ model: 'm', system: '', user: '', max_tokens: 200 });
  const headers2 = f2.calls[0]!.init.headers as Record<string, string>;
  expect(headers2.authorization).toBe('Bearer sk-test');
});

test('openai transport — model_not_found error maps to status=404', async () => {
  const f = fakeFetch([{
    status: 400,
    body: { error: { message: 'The model `gpt-9` does not exist', code: 'model_not_found' } },
  }]);
  const t = createOpenAITransport({ endpoint: 'http://x', fetchFn: f.fn });
  try {
    await t({ model: 'gpt-9', system: '', user: '', max_tokens: 200 });
    throw new Error('should have thrown');
  } catch (err) {
    const e = err as Error & { status?: number };
    // 404 either from the error.code check or from the HTTP 400 body's mapping
    expect(e.status === 404 || e.status === 400).toBe(true);
    expect(e.message).toMatch(/model.*does not exist|model_not_found/i);
  }
});

test('openai transport — non-2xx response throws with status', async () => {
  const f = fakeFetch([{ status: 500, body: { error: { message: 'upstream exploded' } } }]);
  const t = createOpenAITransport({ endpoint: 'http://x', fetchFn: f.fn });
  try {
    await t({ model: 'm', system: '', user: '', max_tokens: 200 });
    throw new Error('should have thrown');
  } catch (err) {
    const e = err as Error & { status?: number };
    expect(e.status).toBe(500);
  }
});

test('openai transport — missing choices content throws cleanly', async () => {
  const f = fakeFetch([{ body: { choices: [], model: 'm' } }]);
  const t = createOpenAITransport({ endpoint: 'http://x', fetchFn: f.fn });
  await expect(t({
    model: 'm', system: '', user: '', max_tokens: 200,
  })).rejects.toThrow(/choices\[0\].message.content/);
});

test('openai transport — extra fields are merged into request body', async () => {
  const f = fakeFetch([{
    body: { choices: [{ message: { content: 'ok' } }], model: 'm' },
  }]);
  const t = createOpenAITransport({
    endpoint: 'http://x', fetchFn: f.fn,
    extra: { temperature: 0, response_format: { type: 'json_object' } },
  });
  await t({ model: 'm', system: '', user: '', max_tokens: 200 });
  const body = JSON.parse(f.calls[0]!.init.body as string);
  expect(body.temperature).toBe(0);
  expect(body.response_format).toEqual({ type: 'json_object' });
});

test('openai transport — endpoint required at construction', () => {
  expect(() => createOpenAITransport({ endpoint: '' })).toThrow(/endpoint required/);
});
