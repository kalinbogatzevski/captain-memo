import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ChunkCache, readCurrent, readTranscript, sessionSkipReason } from './vibe-store.ts';
import { T0, assistantMsg, effectEntry, reasoningEntry, userMsg, writeVibeSession } from '../../../tests/support/vibe-store-fixture.ts';

const roots: string[] = [];
const root = (): string => { const r = mkdtempSync(join(tmpdir(), 'cm-vibe-store-')); roots.push(r); return r; };
afterAll(() => { for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best-effort */ } } });

const read = (dir: string, cache = new ChunkCache(1 << 20)) => readTranscript(dir, cache);
const lines = (dir: string) => read(dir).entries.map((e) => `${e.role}: ${e.text}`);
const chunkFiles = (dir: string) => readdirSync(join(dir, 'chunks'));

test('maps user, committed assistant and tool entries in order; reasoning, notices, checkpoints, system messages and tool output stay out', () => {
  const dir = writeVibeSession(root(), 's1', {
    chunks: [[
      userMsg('question one'),
      reasoningEntry('PRIVATE-THOUGHT'),
      effectEntry('mcp_placeholder.search', { query: 'abc' }, 'completed', 'PRIVATE-TOOL-OUTPUT'),
      { type: 'notice', id: 'n1', generationStatus: 'completed', message: 'Hooks completed', createdAt: T0 },
      assistantMsg('answer one'),
      { type: 'checkpoint', id: 'c1', generationStatus: 'completed', kind: 'compaction', createdAt: T0 },
      { type: 'message', id: 'm1', role: 'system', generationStatus: 'completed', content: [{ type: 'text', text: 'PRIVATE-SYSTEM' }], createdAt: T0 },
    ]],
  });
  expect(lines(dir)).toEqual(['user: question one', 'tool: mcp_placeholder.search({"query":"abc"})', 'assistant: answer one']);
  expect(JSON.stringify(read(dir).entries)).not.toMatch(/PRIVATE/);
});

test('a failed tool call is marked [error]; a skipped or completed one carries no marker', () => {
  const dir = writeVibeSession(root(), 's1', {
    chunks: [[userMsg('go'), effectEntry('a.ok', { n: 1 }), effectEntry('a.bad', { n: 2 }, 'failed', 'boom'), effectEntry('a.skip', { n: 3 }, 'skipped')]],
  });
  expect(lines(dir)).toEqual(['user: go', 'tool: a.ok({"n":1})', 'tool: a.bad({"n":2}) [error]', 'tool: a.skip({"n":3})']);
});

test('tool arguments are clipped to 200 chars; a null input prints empty parens; the name comes from detail.toolName, else title', () => {
  const big = { text: 'x'.repeat(500) };
  const noToolName = { ...effectEntry('ignored', null), detail: { kind: 'tool', input: { k: 1 } }, title: 'from-title' };
  const dir = writeVibeSession(root(), 's1', { chunks: [[userMsg('go'), effectEntry('t.big', big), effectEntry('t.null', null), noToolName]] });
  const [, big_, null_, title_] = read(dir).entries;
  expect(big_!.text.startsWith('t.big({"text":"xxx')).toBe(true);
  expect(big_!.text.length).toBe('t.big()'.length + 200); // clip(…, 200) keeps 200 chars including its ellipsis
  expect(null_!.text).toBe('t.null()');
  expect(title_!.text).toBe('from-title({"k":1})');
});

test('only plain text blocks count: an image and a text resource (a whole file body) never reach the summary', () => {
  const dir = writeVibeSession(root(), 's1', {
    chunks: [[userMsg('', T0, {
      content: [
        { type: 'text', text: 'see this' },
        { type: 'image', attachment: { source: { kind: 'inline', data: 'BASE64-IMAGE' }, alias: 'image', mimeType: 'image/png' } },
        { type: 'resource', resource: { kind: 'text', uri: 'file:///placeholder/a.txt', text: 'FILE-BODY' } },
        { type: 'text', text: 'and that' },
      ],
    })]],
  });
  expect(lines(dir)).toEqual(['user: see this\nand that']);
});

test('long user and assistant text is clipped at the summary cap so the cache holds bounded text', () => {
  const dir = writeVibeSession(root(), 's1', { chunks: [[userMsg('u'.repeat(5000)), assistantMsg('a'.repeat(5000))]] });
  expect(read(dir).entries.map((e) => e.text.length)).toEqual([2000, 2000]);
});

test('provisional entries are left out: an in_progress assistant message, a running tool call, an assistant message that is not committed', () => {
  const dir = writeVibeSession(root(), 's1', {
    chunks: [[
      userMsg('go'),
      effectEntry('t.running', { a: 1 }, 'running', '', T0, { generationStatus: 'in_progress' }),
      assistantMsg('streaming…', T0, { generationStatus: 'in_progress' }),
      assistantMsg('cut off', T0, { outcome: { type: 'interrupted' } }),
      assistantMsg('final'),
    ]],
  });
  expect(lines(dir)).toEqual(['user: go', 'assistant: final']);
});

test('chunks are read in the order the manifest names them; chunk files it does not name (older generations) are ignored', () => {
  const dir = writeVibeSession(root(), 's1', {
    chunks: [[userMsg('one'), assistantMsg('a1')], [userMsg('two'), assistantMsg('a2')], [userMsg('three')]],
    staleChunks: [[userMsg('OLD-GENERATION')]],
  });
  expect(chunkFiles(dir)).toHaveLength(4);
  expect(lines(dir)).toEqual(['user: one', 'assistant: a1', 'user: two', 'assistant: a2', 'user: three']);
});

test('createdAt: milliseconds become whole epoch seconds, a seconds value stays (whole), a missing one is undefined', () => {
  const dir = writeVibeSession(root(), 's1', {
    chunks: [[userMsg('ms', 1_785_000_123_456), userMsg('s', 1_785_000_123), userMsg('frac', 1_785_000_123.9), userMsg('none', 0), { ...userMsg('absent'), createdAt: undefined }]],
  });
  expect(read(dir).entries.map((e) => e.tsEpoch)).toEqual([1_785_000_123, 1_785_000_123, 1_785_000_123, undefined, undefined]);
});

test('unknown entry types, and entries that are not objects, are skipped without breaking the read', () => {
  const dir = writeVibeSession(root(), 's1', { chunks: [[{ type: 'hologram', id: 'h' }, userMsg('still here'), 'not an object', null]] });
  expect(lines(dir)).toEqual(['user: still here']);
});

test('a newer store minor is read anyway, and the minor is reported', () => {
  const dir = writeVibeSession(root(), 's1', { minor: 99, chunks: [[userMsg('still here')]] });
  const { entries, current } = read(dir);
  expect(entries.map((e) => e.text)).toEqual(['still here']);
  expect(current.minor).toBe(99);
});

test('both store minors seen on real machines (8 and 9) read the same', () => {
  const r = root();
  const chunks = [[userMsg('q'), assistantMsg('a')]];
  const a = lines(writeVibeSession(r, 'minor8', { minor: 8, chunks }));
  const b = lines(writeVibeSession(r, 'minor9', { minor: 9, chunks }));
  expect(a).toEqual(b);
  expect(a).toEqual(['user: q', 'assistant: a']);
});

test('a session with nothing in it yet (the folder a Vibe start that did nothing leaves) is an empty transcript, not an error', () => {
  expect(read(writeVibeSession(root(), 'empty', { chunks: [] })).entries).toEqual([]);
  expect(read(writeVibeSession(root(), 'empty2', { chunks: [[]] })).entries).toEqual([]);
});

test('a store written before the chunk pool keeps its entries in the projection envelope', () => {
  const dir = writeVibeSession(root(), 'old', { inline: [userMsg('inline q'), assistantMsg('inline a')] });
  expect(lines(dir)).toEqual(['user: inline q', 'assistant: inline a']);
});

test('a chunk that is gone (the 2-generation collector) throws, and the message carries no content or path', () => {
  const dir = writeVibeSession(root(), 's1', { chunks: [[userMsg('PRIVATE-QUESTION')]] });
  unlinkSync(join(dir, 'chunks', chunkFiles(dir)[0]!));
  let msg = '';
  try { read(dir); } catch (e) { msg = (e as Error).message; }
  expect(msg).toMatch(/^vibe chunk [0-9a-f]{8}: ENOENT$/);
});

test('a torn or malformed CURRENT throws instead of reading as an empty session', () => {
  const dir = writeVibeSession(root(), 's1', { chunks: [[userMsg('q')]] });
  const cur = join(dir, 'CURRENT');
  const good = readFileSync(cur, 'utf8');
  writeFileSync(cur, good.slice(0, 30));
  expect(() => readCurrent(dir)).toThrow('vibe CURRENT: not valid JSON');
  writeFileSync(cur, JSON.stringify({ ...JSON.parse(good), generation: '../../etc' }));
  expect(() => readCurrent(dir)).toThrow('vibe CURRENT: unexpected shape');
  writeFileSync(cur, JSON.stringify({ ...JSON.parse(good), manifest_sha256: 'abc' }));
  expect(() => readCurrent(dir)).toThrow('vibe CURRENT: unexpected shape');
});

test('a manifest chunk name that is not a sha256 (e.g. one that escapes the chunks folder) is refused before join()', () => {
  const dir = writeVibeSession(root(), 's1', { chunks: [[userMsg('q')]] });
  const gen = join(dir, 'generations', '0000000000000001', 'manifest.json');
  const manifest = JSON.parse(readFileSync(gen, 'utf8'));
  writeFileSync(gen, JSON.stringify({ ...manifest, projection_state: { ...manifest.projection_state, chunks: ['../../meta'] } }));
  expect(() => read(dir)).toThrow('vibe manifest: bad chunk name');
});

test('a pre-pool manifest whose projection-state path leaves the generation folder is refused before join()', () => {
  const old = writeVibeSession(root(), 'old', { inline: [userMsg('q')] });
  const gen = join(old, 'generations', '0000000000000001', 'manifest.json');
  const manifest = JSON.parse(readFileSync(gen, 'utf8'));
  writeFileSync(gen, JSON.stringify({ ...manifest, projection_state: { path: '../CURRENT' } }));
  expect(() => read(old)).toThrow('vibe manifest: bad projection-state name');
});

test.skipIf(process.platform === 'win32')('a symlink inside the store is never followed', () => {
  const r = root();
  const dir = writeVibeSession(r, 's1', { chunks: [[userMsg('q')]] });
  const target = join(r, 'elsewhere.json');
  writeFileSync(target, JSON.stringify([userMsg('PRIVATE-ELSEWHERE')]));
  const chunk = join(dir, 'chunks', chunkFiles(dir)[0]!);
  unlinkSync(chunk);
  symlinkSync(target, chunk);
  expect(() => read(dir)).toThrow(/not a regular file/);
});

test('a generation that is not quiescent holds the last user turn back, so a later generation cannot complete a turn already counted', () => {
  const r = root();
  const turn1 = [userMsg('first'), assistantMsg('first answer')];
  // Mid-turn publication: turn 2 has only its user message.
  const mid = writeVibeSession(r, 's1', { generation: 1, execution: 'recoverable', chunks: [[...turn1, userMsg('second')]] });
  expect(lines(mid)).toEqual(['user: first', 'assistant: first answer']);
  // The turn ends: the same turn, now whole, in a quiescent generation.
  writeVibeSession(r, 's1', { generation: 2, execution: 'quiescent', chunks: [[...turn1, userMsg('second'), assistantMsg('second answer')]] });
  expect(lines(mid)).toEqual(['user: first', 'assistant: first answer', 'user: second', 'assistant: second answer']);
  // Any state but "quiescent" holds it, a future one too; with no user message at all there is nothing to show.
  expect(lines(writeVibeSession(r, 's2', { execution: 'something-new', chunks: [[...turn1, userMsg('x')]] }))).toEqual(['user: first', 'assistant: first answer']);
  expect(lines(writeVibeSession(r, 's3', { execution: 'recoverable', chunks: [[assistantMsg('orphan')]] }))).toEqual([]);
});

test('a sealed chunk is parsed once: with the cache a second read survives the file going away, without it the read throws', () => {
  const dir = writeVibeSession(root(), 's1', { chunks: [[userMsg('q'), assistantMsg('a')]] });
  const cached = new ChunkCache(1 << 20);
  read(dir, cached);
  unlinkSync(join(dir, 'chunks', chunkFiles(dir)[0]!)); // the proof the second read did not open it
  expect(read(dir, cached).entries).toHaveLength(2);
  expect(() => read(dir, new ChunkCache(0))).toThrow(/ENOENT/);
});

test('the cache is bounded by the text it holds: the oldest unused chunk is dropped first', () => {
  const r = root();
  const [a, b, c] = ['a', 'b', 'c'].map((ch) => userMsg(ch.repeat(40))); // each chunk costs 41; the cache has room for two
  const x = writeVibeSession(r, 'x', { chunks: [[b], [c]] });
  const y = writeVibeSession(r, 'y', { chunks: [[a]] });
  const z = writeVibeSession(r, 'z', { chunks: [[c]] }); // same entry, so the same chunk file name as x's second chunk
  const w = writeVibeSession(r, 'w', { chunks: [[b]] });
  const cache = new ChunkCache(100);
  read(x, cache); // b, c cached
  read(y, cache); // a in, b out
  for (const dir of [z, w]) unlinkSync(join(dir, 'chunks', chunkFiles(dir)[0]!)); // the files are gone: only the cache can answer
  expect(read(z, cache).entries).toHaveLength(1); // c was kept
  expect(() => read(w, cache)).toThrow(/ENOENT/);   // b was evicted
});

test('sessionSkipReason: a fork or subagent (parent_session_id) and an import are skipped; a root session, and a missing meta.json, are captured', () => {
  const r = root();
  expect(sessionSkipReason(writeVibeSession(r, 'root', {}))).toBeNull();
  expect(sessionSkipReason(writeVibeSession(r, 'fork', { meta: { parent_session_id: 'placeholder-parent' } }))).toBe('child');
  expect(sessionSkipReason(writeVibeSession(r, 'imp', { meta: { import_provenance: { source: 'placeholder' } } }))).toBe('import');
  expect(sessionSkipReason(writeVibeSession(r, 'imp2', { meta: { external_import: { source: 'placeholder' } } }))).toBe('import');
  expect(sessionSkipReason(writeVibeSession(r, 'nometa', { meta: 'none' }))).toBeNull();
});

test('sessionSkipReason: an unreadable meta.json throws (retry next tick) rather than reading as "not a fork"', () => {
  const dir = writeVibeSession(root(), 'torn', { meta: 'torn' });
  expect(() => sessionSkipReason(dir)).toThrow('vibe meta.json: not valid JSON');
  writeFileSync(join(dir, 'meta.json'), '[]');
  expect(() => sessionSkipReason(dir)).toThrow('vibe meta.json: unexpected shape');
});
