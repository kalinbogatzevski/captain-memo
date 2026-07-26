import { test, expect } from 'bun:test';
import { Summarizer, type SummarizerTransport } from '../../src/worker/summarizer.ts';

test('Summarizer exposes its underlying transport for reuse by writeMemory', () => {
  const calls: string[] = [];
  const transport: SummarizerTransport = async (args) => {
    calls.push(args.model);
    return { content: [{ type: 'text', text: '{}' }], model: args.model };
  };
  const s = new Summarizer({ apiKey: '', transport });
  const got = s.getTransport();
  expect(typeof got).toBe('function');
  void got({ model: 'm', system: 's', user: 'u', max_tokens: 10 });
  expect(calls).toEqual(['m']);
});

// writeMemory (frontmatter fill + merge) calls the transport with model:'' to mean
// "you pick" — the subprocess transports (codex/agy) guard on `args.model &&` and fall
// through to the account default, but claude-oauth/claude-code put it straight on the
// wire, which the API rejects with 400 "model: String should have at least 1 character".
// getTransport() is the single choke point every one of those callers routes through,
// so the resolution belongs here rather than in each transport.
test('getTransport() substitutes the configured model when the caller passes an empty one', async () => {
  const calls: string[] = [];
  const transport: SummarizerTransport = async (args) => {
    calls.push(args.model);
    return { content: [{ type: 'text', text: 'ok' }], model: args.model };
  };
  const s = new Summarizer({ apiKey: '', model: 'claude-haiku-4-5', fallbackModels: [], transport });
  await s.getTransport()({ model: '', system: 's', user: 'u', max_tokens: 10 });
  expect(calls).toEqual(['claude-haiku-4-5']);
});

test('getTransport() walks the fallback chain on model_not_found', async () => {
  const calls: string[] = [];
  const transport: SummarizerTransport = async (args) => {
    calls.push(args.model);
    if (args.model === 'gone') {
      const e = new Error('model_not_found') as Error & { status?: number };
      e.status = 404;
      throw e;
    }
    return { content: [{ type: 'text', text: 'ok' }], model: args.model };
  };
  const s = new Summarizer({ apiKey: '', model: 'gone', fallbackModels: ['works'], transport });
  const res = await s.getTransport()({ model: '', system: 's', user: 'u', max_tokens: 10 });
  expect(calls).toEqual(['gone', 'works']);
  expect(res.model).toBe('works');
});

test('getTransport() propagates a non-model error untouched (no silent fallback)', async () => {
  const transport: SummarizerTransport = async () => {
    const e = new Error('HTTP 429: rate_limit_error') as Error & { status?: number };
    e.status = 429;
    throw e;
  };
  const s = new Summarizer({ apiKey: '', model: 'a', fallbackModels: ['b'], transport });
  await expect(s.getTransport()({ model: '', system: 's', user: 'u', max_tokens: 10 }))
    .rejects.toThrow('rate_limit_error');
});
