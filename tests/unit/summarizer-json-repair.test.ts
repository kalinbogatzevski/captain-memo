// tests/unit/summarizer-json-repair.test.ts
//
// The model escapes SOME interior quotes and not others. Real reply that killed two
// observations (rows 41682/41683, replayed against the API 2026-07-26 —
// stop_reason=end_turn, output_tokens=307, so NOT truncation):
//
//   "narrative": "...a straight ASCII double-quote (\") instead of the proper
//                 closing " (U+201D). The phrase „В разговор\" was corrected..."
//                          ^ escaped                        ^ NOT escaped
//
// A JSON string can only end where the next non-space char is , : } ] or EOF.
// Any other '"' must be a literal, so it can be escaped deterministically — no
// second API call, no model cooperation required.
import { test, expect } from 'bun:test';
import { repairJsonQuotes } from '../../src/worker/summarizer.ts';

const parse = (s: string) => JSON.parse(repairJsonQuotes(s));

test('valid JSON is returned untouched', () => {
  const good = '{"a":"b","n":[1,2],"o":{"k":"v"}}';
  expect(repairJsonQuotes(good)).toBe(good);
  expect(parse(good)).toEqual({ a: 'b', n: [1, 2], o: { k: 'v' } });
});

test('escapes the real-world unescaped quote that dead-lettered two observations', () => {
  const broken = '{"type":"bugfix","narrative":"a double-quote (\\") then the proper closing " (U+201D). „В разговор\\" fixed.","facts":["x"]}';
  const got = parse(broken) as { narrative: string; facts: string[] };
  expect(got.narrative).toContain('closing " (U+201D)');
  expect(got.facts).toEqual(['x']);
});

test('does not corrupt structural quotes before , : } ]', () => {
  const broken = '{"a":"say " here","b":["x " y","z"],"c":"end"}';
  const got = parse(broken) as { a: string; b: string[]; c: string };
  expect(got.a).toBe('say " here');
  expect(got.b).toEqual(['x " y', 'z']);
  expect(got.c).toBe('end');
});

test('leaves already-escaped quotes and backslashes alone', () => {
  const s = '{"a":"esc \\" and back \\\\ done"}';
  expect(parse(s)).toEqual({ a: 'esc " and back \\ done' });
});

test('unrepairable input is returned as-is so the caller still throws its own error', () => {
  const hopeless = 'not json at all';
  expect(repairJsonQuotes(hopeless)).toBe(hopeless);
});
