// tests/unit/cli-session-usage.test.ts — Codex, opencode and Gemini session rows, normalised to Claude's meaning.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { readCliSessionUsage, _resetCliUsageCache } from '../../src/worker/cli-session-usage.ts';

let root: string;
let env: Record<string, string>;
const NOW = Date.now();   // the readers filter by file mtime, which is real time
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cm-cli-usage-'));
  env = {
    CODEX_HOME: join(root, 'codex'),
    CAPTAIN_MEMO_CAPTURE_OPENCODE_DB: join(root, 'opencode.db'),
    CAPTAIN_MEMO_CAPTURE_GEMINI_DIR: join(root, 'gemini', 'tmp'),
  };
  _resetCliUsageCache();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const CODEX_ID = '01a19306-0000-7000-8000-000000000001';
const tokenCount = (minAgo: number, total: number, last: { input: number; cached: number; output: number }) => JSON.stringify({
  timestamp: at(minAgo), type: 'event_msg',
  payload: { type: 'token_count', info: {
    total_token_usage: { total_tokens: total },
    last_token_usage: { input_tokens: last.input, cached_input_tokens: last.cached, cache_write_input_tokens: 0, output_tokens: last.output },
  } },
}) + '\n';

function writeRollout(lines: string): string {
  const dir = join(root, 'codex', 'sessions', '2026', '11', '23');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `rollout-2026-11-23T09-00-00-${CODEX_ID}.jsonl`);
  writeFileSync(p, lines);
  return p;
}

test('codex: cached input leaves fresh input, a repeated total is not counted twice, model and effort are the latest', () => {
  writeRollout(
    JSON.stringify({ timestamp: at(50), type: 'session_meta', payload: { id: CODEX_ID, cwd: '/work/app' } }) + '\n'
    + JSON.stringify({ timestamp: at(50), type: 'session_meta', payload: { id: 'someone-elses-copy', cwd: '/elsewhere' } }) + '\n'
    + JSON.stringify({ timestamp: at(50), type: 'turn_context', payload: { model: 'gpt-6-sol', effort: 'medium' } }) + '\n'
    + tokenCount(50, 1100, { input: 1000, cached: 600, output: 100 })      // outside a 30-minute window
    + tokenCount(50, 1100, { input: 1000, cached: 600, output: 100 })      // the same call reported again
    + JSON.stringify({ timestamp: at(5), type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'xhigh' } }) + '\n'
    + tokenCount(5, 1350, { input: 200, cached: 50, output: 50 }));
  const [r] = readCliSessionUsage(30 * 60_000, NOW, env);
  expect(r).toMatchObject({
    cli: 'codex', session_id: CODEX_ID, cwd: '/work/app', model: 'gpt-6.1-sol', effort: 'xhigh',
    input_tokens: 400 + 150, cache_read_tokens: 650, output_tokens: 150,
    window_fresh_tokens: 150, window_cache_read_tokens: 50, window_output_tokens: 50,
  });
});

test('codex: appended lines are read once, a subagent names its parent', () => {
  const p = writeRollout(
    JSON.stringify({ timestamp: at(3), type: 'session_meta', payload: { id: CODEX_ID, thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent-thread' } } } } }) + '\n'
    + tokenCount(3, 110, { input: 100, cached: 0, output: 10 }));
  expect(readCliSessionUsage(30 * 60_000, NOW, env)[0]).toMatchObject({ parentSessionId: 'parent-thread', input_tokens: 100 });
  appendFileSync(p, tokenCount(2, 220, { input: 100, cached: 0, output: 10 }));
  expect(readCliSessionUsage(30 * 60_000, NOW, env)[0]).toMatchObject({ input_tokens: 200, output_tokens: 20 });
});

test('opencode: reasoning counts as output, the variant is the effort, provider names the model', () => {
  const db = new Database(env.CAPTAIN_MEMO_CAPTURE_OPENCODE_DB!);
  db.run('CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, model TEXT, time_updated INTEGER)');
  db.run('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)');
  db.run('INSERT INTO session VALUES (?, NULL, ?, ?, ?)', ['ses_a', '/work/op', JSON.stringify({ id: 'qwen3', providerID: 'ollama', variant: 'high' }), NOW - 60_000]);
  db.run('INSERT INTO session VALUES (?, NULL, ?, ?, ?)', ['ses_old', '/work/op', null, NOW - 3 * 3600_000]);
  db.run('INSERT INTO message VALUES (?, ?, ?)', ['m1', 'ses_a', JSON.stringify({ role: 'user', time: { created: NOW - 70_000 } })]);
  db.run('INSERT INTO message VALUES (?, ?, ?)', ['m2', 'ses_a', JSON.stringify({ role: 'assistant', modelID: 'qwen3', providerID: 'ollama',
    tokens: { input: 73, output: 4, reasoning: 6, cache: { read: 7304, write: 9 } }, time: { created: NOW - 60_000 } })]);
  db.close();
  const rows = readCliSessionUsage(30 * 60_000, NOW, env);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ cli: 'opencode', session_id: 'ses_a', cwd: '/work/op', model: 'ollama/qwen3', effort: 'high',
    input_tokens: 73, cache_creation_tokens: 9, cache_read_tokens: 7304, output_tokens: 10, window_fresh_tokens: 82 });
});

test('gemini: cached input leaves fresh input, thoughts count as output, the project slug gives the cwd, no effort', () => {
  const chats = join(root, 'gemini', 'tmp', 'my-proj', 'chats');
  mkdirSync(chats, { recursive: true });
  writeFileSync(join(root, 'gemini', 'projects.json'), JSON.stringify({ projects: { '/work/gem': 'my-proj' } }));
  writeFileSync(join(chats, 'session-2026-11-23T09-50-abcdef12.json'), JSON.stringify({
    sessionId: 'abcdef12-0000-4000-8000-000000000000', projectHash: 'x',
    messages: [
      { type: 'user', content: 'hi', timestamp: at(10) },
      { type: 'gemini', model: 'gemini-3-pro-preview', timestamp: at(9), tokens: { input: 1000, output: 20, cached: 400, thoughts: 30, total: 1050 } },
    ],
  }, null, 2));   // pretty-printed, as the CLI writes .json sessions
  const [r] = readCliSessionUsage(30 * 60_000, NOW, env);
  expect(r).toMatchObject({ cli: 'gemini', session_id: 'abcdef12-0000-4000-8000-000000000000', cwd: '/work/gem',
    model: 'gemini-3-pro-preview', input_tokens: 600, cache_read_tokens: 400, output_tokens: 50 });
  expect(r!.effort).toBeUndefined();
});

test('no CLI stores at all: nothing, never a throw', () => {
  expect(readCliSessionUsage(30 * 60_000, NOW, env)).toEqual([]);
});

test('gemini: a resumed session (a second file, same sessionId) is ONE row with both files\' tokens', () => {
  const chats = join(root, 'gemini', 'tmp', 'hashdir', 'chats');
  mkdirSync(chats, { recursive: true });
  const sid = '0d0d0d0d-0000-4000-8000-000000000000';
  const file = (model: string, input: number) => JSON.stringify({ sessionId: sid, projectHash: 'x', messages: [
    { type: 'gemini', model, timestamp: at(5), tokens: { input, output: 1, cached: 0, thoughts: 0 } }] }, null, 2);
  writeFileSync(join(chats, 'session-2026-11-23T09-40-0d0d0d0d.json'), file('gemini-a', 100));
  writeFileSync(join(chats, 'session-2026-11-23T09-50-0d0d0d0d.json'), file('gemini-b', 50));
  const rows = readCliSessionUsage(30 * 60_000, NOW, env);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ session_id: sid, input_tokens: 150, output_tokens: 2 });
  expect(rows[0]!.cwd).toBeUndefined();   // a hash folder names no path
});

test('a worker that owns no host sessions (CAPTAIN_MEMO_CLI_SESSION_ROWS=0) reports none', () => {
  writeRollout(JSON.stringify({ timestamp: at(1), type: 'session_meta', payload: { id: CODEX_ID } }) + '\n');
  expect(readCliSessionUsage(30 * 60_000, NOW, env)).toHaveLength(1);
  expect(readCliSessionUsage(30 * 60_000, NOW, { ...env, CAPTAIN_MEMO_CLI_SESSION_ROWS: '0' })).toEqual([]);
});
