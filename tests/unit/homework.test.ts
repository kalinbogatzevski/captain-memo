import { test, expect } from 'bun:test';
import { addHomework, listHomework, claimHomework, unclaimHomework, doneHomework, getHomework, parseHomeworkPrompt, homeworkFiledLine, homeworkStartLines, HOMEWORK_DONE_KEEP_MS } from '../../src/worker/homework.ts';
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

// Due times: a reminder on a homework item. The host zone is pinned per assertion, so a date-only value that wrongly meant
// UTC midnight cannot pass just because the machine running the suite is on UTC. The zone has to be set BEFORE the process
// starts: switching process.env.TZ in a running process is honoured by some Bun builds and ignored by others (CI), so each
// zone runs in a child. Not run on Windows, whose zone handling is not POSIX TZ.
const HW = new URL('../../src/worker/homework.ts', import.meta.url).href;
function inZone<T>(tz: string, body: string): T {
  const src = `import * as hw from ${JSON.stringify(HW)}; const { parseDue, homeworkDueParts, homeworkStartLines } = hw; console.log(JSON.stringify((() => { ${body} })()));`;
  const r = Bun.spawnSync([process.execPath, '-e', src], { env: { ...process.env, TZ: tz } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString()) as T;
}
const zoneTest = process.platform === 'win32' ? test.skip : test;

zoneTest('due: a date-only value is this host\'s midnight, a date-time without a zone is host-local, an explicit zone wins', () => {
  expect(inZone<string[]>('Asia/Tokyo', `return [parseDue('2026-10-01'), parseDue('2026-10-01T09:30'), parseDue(' 2026-10-01T09:30:15 ')];`))
    .toEqual(['2026-09-30T15:00:00.000Z', '2026-10-01T00:30:00.000Z', '2026-10-01T00:30:15.000Z']);
  expect(inZone<string[]>('America/Los_Angeles', `return [parseDue('2026-10-01'), parseDue('2026-10-01T09:30')];`))
    .toEqual(['2026-10-01T07:00:00.000Z', '2026-10-01T16:30:00.000Z']);
  expect(inZone<string[]>('Asia/Tokyo', `return [parseDue('2026-10-01T00:05+02:00'), parseDue('2026-10-01T09:30Z'), parseDue('2028-02-29')];`))
    .toEqual(['2026-09-30T22:05:00.000Z', '2026-10-01T09:30:00.000Z', '2028-02-28T15:00:00.000Z']);   // a leap day that exists
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

zoneTest('due: due items lead soonest first, the rest keep their order, labels are in the host zone, a done item is never due', () => {
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
  const tokyo = inZone<{ parts: string[][]; lines: string[] }>('Asia/Tokyo',
    `const items = ${JSON.stringify(items)}; const NOW = ${NOW}; return { parts: [homeworkDueParts(items[2], NOW), homeworkDueParts(items[1], NOW), homeworkDueParts(items[0], NOW)], lines: homeworkStartLines(items, NOW).split('\\n') };`);
  expect(tokyo.parts).toEqual([['⏰ ', ' (DUE since 2026-10-01 19:00)'], ['', ' (due 2027-01-01 09:00)'], ['', '']]);
  expect(tokyo.lines.slice(1)).toEqual(['  ⏰ #4 item 4 (DUE since 2026-09-30 19:00)', '  ⏰ #3 item 3 (DUE since 2026-10-01 19:00)', '  #1 item 1', '  #2 item 2 (due 2027-01-01 09:00)', '  #5 item 5', '  #6 item 6 (due 2026-10-03 09:00)']);
  const done = it('7', { due: '2020-01-01T00:00:00.000Z', done_at: 5 });
  expect(isHomeworkDue(done, NOW)).toBe(false);
  expect(homeworkDueParts(done, NOW)).toEqual(['', '']);
  expect(homeworkDueFirst([it('8'), done], NOW).map((i) => i.id)).toEqual(['8', '7']);
  const kv = makeKv();
  addHomework(kv, { text: 'late and finished', due: '2020-01-01T00:00Z' }, 1_000);
  doneHomework(kv, '1', 'x', 'done', 2_000);
  expect(listHomework(kv, { status: 'open' }, 3_000)).toEqual([]);   // what the session-start list is fed from
});

test('unclaim: you can hand back your own claim; not another session\'s, not an unclaimed item, not a closed or unknown one', () => {
  const kv = makeKv();
  addHomework(kv, { text: 'look at this', by: 'a' }, 1_000);
  expect(unclaimHomework(kv, '1', 'erp-17')).toMatchObject({ error: 'not_claimed' });
  claimHomework(kv, '1', 'erp-17', 2_000);
  expect(unclaimHomework(kv, '1', 'erp-18')).toMatchObject({ error: 'not_yours' });
  expect(getHomework(kv, '1')?.claimed_by).toBe('erp-17');                         // refused: still theirs
  const r = unclaimHomework(kv, '#1', 'erp-17') as { item: NonNullable<ReturnType<typeof getHomework>> };
  expect(r.item).not.toHaveProperty('claimed_by'); expect(r.item).not.toHaveProperty('claimed_at');
  expect(getHomework(kv, '1')).toEqual(r.item);                                     // persisted, not only on the returned object
  expect(claimHomework(kv, '1', 'erp-18', 3_000)?.claimed_by).toBe('erp-18');      // free to take again
  expect(unclaimHomework(kv, '99', 'x')).toMatchObject({ error: 'not_found' });
  doneHomework(kv, '1', 'erp-18', 'ok', 4_000);
  expect(unclaimHomework(kv, '1', 'erp-18')).toMatchObject({ error: 'not_found' }); // a closed item has no claim to hand back
});
