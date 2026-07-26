// tests/unit/summarizer-json-robustness.test.ts
//
// Origin (2026-07-26): requeuing 675 dead-lettered observations surfaced repeated
// `failed to parse JSON: Expected '}'` / `Unterminated string`. Replaying a failing
// batch against the real API proved the cause was NOT truncation (output_tokens=241
// of a 4096 budget) and NOT the greedy extraction regex — the model had emitted an
// UNESCAPED `"` inside a JSON string, because the observation itself was about
// quotation marks:
//     "narrative": "...ASCII double-quote (") was used instead of..."
// Content-dependent and deterministic: every retry fails identically, so the rows
// dead-lettered. These tests pin the three defects that made it hard to see.
import { test, expect } from 'bun:test';
import { Summarizer, type SummarizerTransport } from '../../src/worker/summarizer.ts';

const ok = (text: string, extra: Record<string, unknown> = {}): SummarizerTransport =>
  async (args) => ({ content: [{ type: 'text', text }], model: args.model, ...extra });

const EVENTS = [{
  session_id: 's', project_id: 'p', prompt_number: 1, tool_name: 'Edit',
  tool_input_summary: 'x', tool_result_summary: 'y',
  files_read: [], files_modified: [], ts_epoch: 0,
}] as never;

const GOOD = JSON.stringify({
  type: 'bugfix', title: 't', narrative: 'n', facts: ['f'], concepts: ['c'],
});

test('a max_tokens truncation reports itself, not a downstream parse error', async () => {
  // Truncated mid-string. Before: "JSON Parse error: Unterminated string" — which sent
  // us hunting the wrong bug. The API already says stop_reason:'max_tokens'; use it.
  const s = new Summarizer({
    apiKey: '', model: 'm', fallbackModels: [],
    transport: ok('{"type":"bugfix","title":"t","narrative":"unterminated', { stop_reason: 'max_tokens' }),
  });
  await expect(s.summarize(EVENTS)).rejects.toThrow(/truncated|max_tokens/i);
});

test('a parse failure includes the offending text so it is diagnosable from the log', async () => {
  // Structurally broken, NOT just a stray quote — repairJsonQuotes rescues the latter,
  // so this has to be something no repair can save for the message to be reachable.
  const s = new Summarizer({
    apiKey: '', model: 'm', fallbackModels: [],
    transport: ok('{"type" "bugfix" narrative broke me }'),
  });
  await expect(s.summarize(EVENTS)).rejects.toThrow(/broke me/);
});

test('the system prompt tells the model to escape interior double quotes', async () => {
  let seenSystem = '';
  const s = new Summarizer({
    apiKey: '', model: 'm', fallbackModels: [],
    transport: async (args) => { seenSystem = args.system; return { content: [{ type: 'text', text: GOOD }], model: args.model }; },
  });
  await s.summarize(EVENTS);
  expect(seenSystem.toLowerCase()).toContain('escape');
});

test('the greedy extraction regex is PRESERVED — it is what strips a ```json fence', async () => {
  // Guard against "fixing" this into a non-greedy match: the closing ``` sits after
  // the final }, so a lazy match would stop at the first } and break every fenced reply.
  const s = new Summarizer({
    apiKey: '', model: 'm', fallbackModels: [],
    transport: ok('```json\n' + JSON.stringify({
      type: 'feature', title: 't', narrative: 'n',
      facts: ['nested {braces} inside'], concepts: ['c'],
    }) + '\n```'),
  });
  const r = await s.summarize(EVENTS);
  expect(r.type).toBe('feature');
  expect(r.facts[0]).toContain('{braces}');
});
