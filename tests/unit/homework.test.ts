import { test, expect } from 'bun:test';
import { addHomework, listHomework, claimHomework, doneHomework, getHomework, parseHomeworkPrompt, homeworkFiledLine, homeworkStartLines, HOMEWORK_DONE_KEEP_MS } from '../../src/worker/homework.ts';
import { parseDue, isHomeworkDue, homeworkDueFirst, homeworkDueParts, type HomeworkItem } from '../../src/worker/homework.ts';

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

// Due times: a reminder on a homework item. The host zone is pinned per test, so a date-only value that wrongly meant
// UTC midnight cannot pass just because the machine running the suite is on UTC.
function inZone<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
}

test('due: a date-only value is this host\'s midnight, a date-time without a zone is host-local, an explicit zone wins', () => {
  inZone('Asia/Tokyo', () => {
    expect(parseDue('2026-10-01')).toBe('2026-09-30T15:00:00.000Z');
    expect(parseDue('2026-10-01T09:30')).toBe('2026-10-01T00:30:00.000Z');
    expect(parseDue(' 2026-10-01T09:30:15 ')).toBe('2026-10-01T00:30:15.000Z');
  });
  inZone('America/Los_Angeles', () => {
    expect(parseDue('2026-10-01')).toBe('2026-10-01T07:00:00.000Z');
    expect(parseDue('2026-10-01T09:30')).toBe('2026-10-01T16:30:00.000Z');
  });
  inZone('Asia/Tokyo', () => {
    expect(parseDue('2026-10-01T00:05+02:00')).toBe('2026-09-30T22:05:00.000Z');
    expect(parseDue('2026-10-01T09:30Z')).toBe('2026-10-01T09:30:00.000Z');
    expect(parseDue('2028-02-29')).toBe('2028-02-28T15:00:00.000Z');   // a leap day that exists
  });
});

test('due: anything that is not an ISO date or date-time is refused, impossible dates included', () => {
  const bad = ['tomorrow', 'next week', '', '   ', 'x2026-10-01', '2026-10', '2026', '2026-09-31', '2026-02-29', '2026-02-29T10:00', '2026-04-31T08:00', '2026-13-01', '2026-00-10', '2026-10-01T25:00', '2026-10-01 garbage', 5, null, {}, ['2026-10-01']];
  for (const b of bad) expect(() => parseDue(b), JSON.stringify(b)).toThrow('bad_due');
});

test('due: a refused due files nothing and uses up no number; a past due is accepted', () => {
  const kv = makeKv();
  expect(() => addHomework(kv, { text: 'x', due: 'soon' })).toThrow('bad_due');
  expect(() => addHomework(kv, { text: 'x', due: '' })).toThrow('bad_due');
  expect(listHomework(kv)).toEqual([]);
  const past = addHomework(kv, { text: 'already late', due: '2020-01-01T00:00Z' }, 1_000);
  expect(past.id).toBe('1');
  expect(getHomework(kv, '1')?.due).toBe('2020-01-01T00:00:00.000Z');
  expect(isHomeworkDue(past, Date.parse('2026-10-01T00:00Z'))).toBe(true);
});

test('due: an item filed without one is stored exactly as before, and a row stored before the field existed still lists and prints as before', () => {
  const kv = makeKv();
  const plain = addHomework(kv, { text: 'no due time', by: 'sess-1' }, 1_000);
  expect('due' in plain).toBe(false);
  expect(JSON.parse(kv.getKv('hw:00000001')!)).toEqual({ id: '1', text: 'no due time', topics: [], by: 'sess-1', created_at: 1_000 });
  kv.setKv('hw:00000002', JSON.stringify({ id: '2', text: 'filed by 0.55', topics: ['old'], by: 'hook', created_at: 5, claimed_by: 'erp-18', claimed_at: 6 }));
  const items = listHomework(kv, {}, 2_000);
  expect(items.map((i) => i.id)).toEqual(['1', '2']);
  expect(homeworkStartLines(items, Date.parse('2026-10-01T00:00Z'))).toBe([
    '📝 Open homework on this captain (2): todo_list() for all; todo_claim(id) before you start one; todo_done(id, note) when it is.',
    '  #1 no due time',
    '  #2 filed by 0.55 (claimed by erp-18) #old',
  ].join('\n'));
  expect(claimHomework(kv, '1', 'x', 3_000)).not.toHaveProperty('due');
});

test('due: due items lead soonest first, the rest keep their order, labels are in the host zone, a done item is never due', () => {
  const NOW = Date.parse('2026-10-02T00:00Z');
  const it = (id: string, extra: Partial<HomeworkItem> = {}): HomeworkItem => ({ id, text: `item ${id}`, topics: [], by: 'x', created_at: 1, ...extra });
  const items = [
    it('1'),
    it('2', { due: '2027-01-01T00:00:00.000Z' }),               // not due yet: keeps its place
    it('3', { due: '2026-10-01T10:00:00.000Z' }),
    it('4', { due: '2026-09-30T10:00:00.000Z' }),               // due longest: first
    it('5'),
    it('6', { due: '2026-10-03T00:00:00.000Z' }),               // tomorrow: keeps its place
  ];
  expect(homeworkDueFirst(items, NOW).map((i) => i.id)).toEqual(['4', '3', '1', '2', '5', '6']);
  expect(homeworkDueFirst(items, Date.parse('2026-09-01T00:00Z')).map((i) => i.id)).toEqual(['1', '2', '3', '4', '5', '6']);   // nothing due yet: order as given
  inZone('Asia/Tokyo', () => {
    expect(homeworkDueParts(items[2]!, NOW)).toEqual(['⏰ ', ' (DUE since 2026-10-01 19:00)']);
    expect(homeworkDueParts(items[1]!, NOW)).toEqual(['', ' (due 2027-01-01 09:00)']);
    expect(homeworkDueParts(items[0]!, NOW)).toEqual(['', '']);
    const lines = homeworkStartLines(items, NOW).split('\n');
    expect(lines.slice(1)).toEqual(['  ⏰ #4 item 4 (DUE since 2026-09-30 19:00)', '  ⏰ #3 item 3 (DUE since 2026-10-01 19:00)', '  #1 item 1', '  #2 item 2 (due 2027-01-01 09:00)', '  #5 item 5', '  #6 item 6 (due 2026-10-03 09:00)']);
  });
  const done = it('7', { due: '2020-01-01T00:00:00.000Z', done_at: 5 });
  expect(isHomeworkDue(done, NOW)).toBe(false);
  expect(homeworkDueParts(done, NOW)).toEqual(['', '']);
  expect(homeworkDueFirst([it('8'), done], NOW).map((i) => i.id)).toEqual(['8', '7']);
  const kv = makeKv();
  addHomework(kv, { text: 'late and finished', due: '2020-01-01T00:00Z' }, 1_000);
  doneHomework(kv, '1', 'x', 'done', 2_000);
  expect(listHomework(kv, { status: 'open' }, 3_000)).toEqual([]);   // what the session-start list is fed from
});
