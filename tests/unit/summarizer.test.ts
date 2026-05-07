import { test, expect, mock } from 'bun:test';
import { Summarizer } from '../../src/worker/summarizer.ts';
import type { RawObservationEvent } from '../../src/shared/types.ts';

const ev = (over: Partial<RawObservationEvent> = {}): RawObservationEvent => ({
  session_id: 's1', project_id: 'p1', prompt_number: 1,
  tool_name: 'Edit', tool_input_summary: 'edit foo.ts',
  tool_result_summary: 'ok',
  files_read: [], files_modified: ['foo.ts'],
  ts_epoch: 1_700_000_000,
  ...over,
});

test('Summarizer — happy path returns parsed structured summary', async () => {
  const transport = mock(async () => ({
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        type: 'bugfix',
        title: 'fixed off-by-one',
        narrative: 'replaced 1-indexed loop with 0-indexed',
        facts: ['loop started at 1', 'should start at 0'],
        concepts: ['off-by-one'],
      }),
    }],
    model: 'claude-haiku-4-6',
  }));
  const s = new Summarizer({
    apiKey: 'test-key', model: 'claude-haiku-4-6',
    transport,
  });
  const res = await s.summarize([ev()]);
  expect(res.type).toBe('bugfix');
  expect(res.title).toBe('fixed off-by-one');
  expect(res.facts).toHaveLength(2);
  expect(transport).toHaveBeenCalledTimes(1);
});

test('Summarizer — walks fallback chain on model_not_found', async () => {
  let calls = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transport = mock(async (_args: any) => {
    calls++;
    if (calls === 1) {
      const err = new Error('model_not_found') as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        type: 'change', title: 't', narrative: 'n', facts: [], concepts: [],
      })}],
      model: 'claude-haiku-4-5',
    };
  });
  const s = new Summarizer({
    apiKey: 'test-key', model: 'claude-haiku-4-6',
    fallbackModels: ['claude-haiku-4-5'],
    transport,
  });
  const res = await s.summarize([ev()]);
  expect(res.type).toBe('change');
  expect(transport).toHaveBeenCalledTimes(2);
  // Subsequent calls reuse fallback (no extra retry)
  await s.summarize([ev()]);
  expect(transport).toHaveBeenCalledTimes(3);
});

test('Summarizer — invalid JSON in response raises', async () => {
  const transport = mock(async () => ({
    content: [{ type: 'text' as const, text: 'not json' }],
    model: 'claude-haiku-4-6',
  }));
  const s = new Summarizer({
    apiKey: 'test-key', model: 'claude-haiku-4-6', transport,
  });
  await expect(s.summarize([ev()])).rejects.toThrow(/JSON|parse/i);
});

test('Summarizer — type field validated against ObservationType enum', async () => {
  const transport = mock(async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify({
      type: 'INVALID_TYPE', title: 't', narrative: 'n', facts: [], concepts: [],
    })}],
    model: 'claude-haiku-4-6',
  }));
  const s = new Summarizer({
    apiKey: 'test-key', model: 'claude-haiku-4-6', transport,
  });
  await expect(s.summarize([ev()])).rejects.toThrow(/type|enum|invalid/i);
});

test('Summarizer — empty events list returns empty narrative observation', async () => {
  const transport = mock(async () => { throw new Error('should not be called'); });
  const s = new Summarizer({
    apiKey: 'test-key', model: 'claude-haiku-4-6', transport,
  });
  const res = await s.summarize([]);
  expect(res.facts).toEqual([]);
  expect(transport).not.toHaveBeenCalled();
});

test('Summarizer — missing API key throws on construction (default transport)', () => {
  // Without a custom transport, the default Anthropic SDK transport needs an
  // apiKey. With one (e.g. the Claude Code subprocess transport), apiKey is
  // not required because auth is handled inside the transport.
  expect(() => new Summarizer({
    apiKey: '', model: 'claude-haiku-4-6',
  })).toThrow(/api[_ ]key|apiKey/i);
});

test('Summarizer — accepts empty apiKey when a custom transport is supplied', () => {
  expect(() => new Summarizer({
    apiKey: '', model: 'claude-haiku-4-6',
    transport: async () => ({ content: [{ type: 'text' as const, text: '{}' }], model: 'x' }),
  })).not.toThrow();
});
