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
