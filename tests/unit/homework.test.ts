import { test, expect } from 'bun:test';
import { addHomework, listHomework, claimHomework, doneHomework, getHomework, parseHomeworkPrompt, homeworkFiledLine, homeworkStartLines, HOMEWORK_DONE_KEEP_MS } from '../../src/worker/homework.ts';

function makeKv() {
  const map = new Map<string, string>();
  return { getKv: (k: string) => map.get(k) ?? null, setKv: (k: string, v: string) => { map.set(k, v); }, listKvPrefix: (p: string) => [...map.entries()].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })), deleteKv: (k: string) => { map.delete(k); } };
}

test('homework: sequential ids, open → claimed → done lifecycle, done items listable a week then reaped', () => {
  const kv = makeKv();
  const a = addHomework(kv, { text: 'cockpit: a comms thread per session', topics: ['Cockpit Board', 'comms', 'x'.repeat(50)], project: 'captain-hub', by: 'sess-1' }, 1_000);
  const b = addHomework(kv, { text: 'todo list on the captain\nsecond line', by: 'hook' }, 2_000);
  expect([a.id, b.id]).toEqual(['1', '2']);
  expect(a.topics).toEqual(['cockpit-board', 'comms', 'x'.repeat(40)]);
  expect(() => addHomework(kv, { text: '   ' })).toThrow();
  expect(listHomework(kv, {}, 2_500).map((i) => i.id)).toEqual(['1', '2']);
  expect(claimHomework(kv, '#2', 'sess-9', 3_000)?.claimed_by).toBe('sess-9');
  expect(getHomework(kv, '2')?.claimed_at).toBe(3_000);
  expect(doneHomework(kv, '1', 'sess-1', 'shipped in hub ab65d81', 4_000)?.note).toBe('shipped in hub ab65d81');
  expect(listHomework(kv, { status: 'open' }, 5_000).map((i) => i.id)).toEqual(['2']);
  expect(listHomework(kv, { status: 'done' }, 5_000).map((i) => i.id)).toEqual(['1']);
  expect(listHomework(kv, { status: 'all' }, 5_000)).toHaveLength(2);
  expect(claimHomework(kv, '1', 'x')).toBeNull();                              // done is done
  expect(listHomework(kv, { status: 'all' }, 4_000 + HOMEWORK_DONE_KEEP_MS + 1).map((i) => i.id)).toEqual(['2']);   // reaped
  expect(getHomework(kv, '1')).toBeNull();
  expect(doneHomework(kv, '404', 'x')).toBeNull();
});

test('homework: the capture prefix and the two lines the hooks inject', () => {
  expect(parseHomeworkPrompt('idea: captain keeps a todo list')).toBe('captain keeps a todo list');
  expect(parseHomeworkPrompt('  TODO - fix the top scroll\nmore')).toBe('fix the top scroll\nmore');
  expect(parseHomeworkPrompt('идея: списък със задачи')).toBe('списък със задачи');
  expect(parseHomeworkPrompt('fix the top scroll')).toBeNull();
  expect(parseHomeworkPrompt('idea:')).toBeNull();
  const kv = makeKv();
  const it = addHomework(kv, { text: 'captain keeps a todo list', topics: ['captain'] }, 1_000);
  expect(homeworkFiledLine(it)).toContain('Filed as homework #1');
  expect(homeworkStartLines([])).toBe('');
  const lines = homeworkStartLines([it, claimHomework(kv, '1', 'erp-18')!]);
  expect(lines).toContain('Open homework on this captain (2)');
  expect(lines).toContain('(claimed by erp-18)');
  expect(lines).toContain('#captain');
});
