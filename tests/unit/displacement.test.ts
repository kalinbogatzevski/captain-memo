// tests/unit/displacement.test.ts
//
// The displacement proxy compares discovery-tool usage in turns that received memory
// against turns that did not. Two methodology traps are pinned here because both
// silently produce a WRONG ANSWER rather than an error:
//
//   1. Tool results arrive with role "user". Counting them as turns inflates the
//      denominator ~10x and drives both arms to zero — the first run reported 0.02 vs
//      0.04 and looked like a null result for entirely the wrong reason.
//   2. A difference without a p-value invites the overclaim. The first honest run
//      showed a 13% reduction at p = 0.38: noise, presented alone it reads as proof.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { displacementReport } from '../../src/eval/displacement.ts';

let root: string, projectDir: string, auditPath: string;
const SID = '46ab9cc1-777d-4179-ba55-609de944146c';
const T0 = 1_800_000_000_000;

const iso = (ms: number) => new Date(ms).toISOString();
const userTurn = (ms: number) => JSON.stringify({ type: 'user', timestamp: iso(ms), message: { content: 'do a thing' } });
const toolResult = (ms: number) => JSON.stringify({
  type: 'user', timestamp: iso(ms),
  message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
});
const assistantTools = (ms: number, names: string[]) => JSON.stringify({
  type: 'assistant', timestamp: iso(ms),
  message: { content: names.map((n, i) => ({ type: 'tool_use', id: 'id' + i, name: n })) },
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cm-displace-'));
  projectDir = join(root, '-proj');
  mkdirSync(projectDir, { recursive: true });
  auditPath = join(root, 'recall-audit.jsonl');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(lines: string[], injections: number[]) {
  writeFileSync(join(projectDir, `${SID}.jsonl`), lines.join('\n') + '\n');
  writeFileSync(auditPath, injections.map(ts =>
    JSON.stringify({ ts, session_id: SID, injected_tokens: 900 })).join('\n') + '\n');
}

const run = () => displacementReport({ transcriptsRoot: root, auditPath, now: T0 + 3_600_000 });

test('a tool result does not start a new turn', async () => {
  // One prompt, three tool round-trips. That is ONE turn, not four.
  write([
    userTurn(T0),
    assistantTools(T0 + 1000, ['Read']),
    toolResult(T0 + 2000),
    assistantTools(T0 + 3000, ['Grep']),
    toolResult(T0 + 4000),
    userTurn(T0 + 60_000),                       // second real turn, no injection
    assistantTools(T0 + 61_000, ['Bash']),
  ], [T0]);                                       // injection matches only the first turn

  const r = await run();
  expect(r.turns_with_memory).toBe(1);
  expect(r.turns_without_memory).toBe(1);
  // The injected turn used TWO discovery calls across its tool round-trips.
  expect(r.mean_discovery_with).toBe(2);
  expect(r.mean_discovery_without).toBe(0);      // Bash is not discovery
});

test('only discovery tools count toward the effect, but all tools count as activity', async () => {
  write([
    userTurn(T0),
    assistantTools(T0 + 1000, ['Read', 'Glob', 'Bash', 'Edit']),
    userTurn(T0 + 60_000),
    assistantTools(T0 + 61_000, ['Bash']),
  ], [T0]);
  const r = await run();
  expect(r.mean_discovery_with).toBe(2);         // Read + Glob
  expect(r.mean_total_with).toBe(4);             // control: everything
});

test('a report always carries a p-value and a significance verdict', async () => {
  write([
    userTurn(T0),
    assistantTools(T0 + 1000, ['Read']),
    userTurn(T0 + 60_000),
    assistantTools(T0 + 61_000, ['Read', 'Read']),
  ], [T0]);
  const r = await run();
  expect(typeof r.p_value).toBe('number');
  expect(typeof r.significant).toBe('boolean');
  // Two turns cannot establish anything — the verdict must not claim otherwise.
  expect(r.significant).toBe(false);
});

test('a session where memory never fired is excluded entirely', async () => {
  // Without both arms the comparison is cross-session, which measures what those
  // sessions happened to be doing rather than the effect of memory.
  write([userTurn(T0), assistantTools(T0 + 1000, ['Read'])], [T0 - 999_999_999]);
  const r = await run();
  expect(r.sessions_analysed).toBe(0);
});

test('no audit log at all yields a null report, not a crash', async () => {
  writeFileSync(join(projectDir, `${SID}.jsonl`), userTurn(T0) + '\n');
  const r = await displacementReport({ transcriptsRoot: root, auditPath: join(root, 'nope.jsonl') });
  expect(r.sessions_analysed).toBe(0);
  expect(r.p_value).toBe(1);
  expect(r.significant).toBe(false);
});
