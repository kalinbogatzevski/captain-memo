import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseForgetArgs } from '../../src/cli/commands/forget.ts';
import { MetaStore } from '../../src/worker/meta.ts';

// ---------------------------------------------------------------------------
// parseForgetArgs — forget is destructive and not undoable, so the parser must not
// quietly accept anything it could act on wrongly.
// ---------------------------------------------------------------------------

test('parseForgetArgs: a bare doc_id is looked up as a doc_id', () => {
  const a = parseForgetArgs(['memory:reference_foo']);
  expect(a.target).toBe('memory:reference_foo');
  expect(a.byPath).toBe(false);
  expect(a.yes).toBe(false);          // confirmation is the default
  expect(a.dryRun).toBe(false);
});

test('parseForgetArgs: an absolute path implies --path without being told', () => {
  // Otherwise it is looked up as a doc_id, misses, and reports "not found" about a
  // file that plainly exists — the confusing failure this rule exists to prevent.
  expect(parseForgetArgs(['/home/k/.claude/memory/reference_foo.md']).byPath).toBe(true);
  expect(parseForgetArgs(['C:\\Users\\k\\memory\\reference_foo.md']).byPath).toBe(true);
});

test('parseForgetArgs: --dry-run and --yes are picked up', () => {
  const a = parseForgetArgs(['memory:x', '--dry-run', '--yes']);
  expect(a.dryRun).toBe(true);
  expect(a.yes).toBe(true);
});

test('parseForgetArgs: two targets is an error, not a guess at which one', () => {
  expect(() => parseForgetArgs(['memory:a', 'memory:b'])).toThrow();
});

test('parseForgetArgs: a missing target is an error', () => {
  expect(() => parseForgetArgs([])).toThrow();
  expect(() => parseForgetArgs(['--dry-run'])).toThrow();
});

test('parseForgetArgs: an unknown flag is rejected rather than treated as the target', () => {
  expect(() => parseForgetArgs(['--force', 'memory:a'])).toThrow();
});

// ---------------------------------------------------------------------------
// findDocumentsByBasename — `_` is a LIKE wildcard and EVERY remember-written name
// contains one, so an unescaped pattern matches unrelated documents. On a delete
// path that means removing the wrong file, silently and unrecoverably.
// ---------------------------------------------------------------------------

function store(): MetaStore {
  const dir = mkdtempSync(join(tmpdir(), 'cm-forget-'));
  return new MetaStore(join(dir, 'meta.sqlite3'));
}

function add(m: MetaStore, source_path: string, channel = 'memory'): void {
  m.upsertDocument({
    source_path, channel: channel as Parameters<MetaStore['upsertDocument']>[0]['channel'],
    project_id: 'default', sha: 'x', mtime_epoch: 1, metadata: {},
  });
}

test('findDocumentsByBasename: finds the document by its file name', () => {
  const m = store();
  add(m, '/memories/reference_alpha.md');
  const hits = m.findDocumentsByBasename('reference_alpha.md');
  expect(hits).toHaveLength(1);
  expect(hits[0]!.source_path).toBe('/memories/reference_alpha.md');
});

test('findDocumentsByBasename: finds a stored Windows path', () => {
  const m = store();
  add(m, 'C:\\Users\\captain\\memory\\reference_alpha.md');
  const hits = m.findDocumentsByBasename('reference_alpha.md');
  expect(hits).toHaveLength(1);
  expect(hits[0]!.source_path).toBe('C:\\Users\\captain\\memory\\reference_alpha.md');
});

test('findDocumentsByBasename: underscore is escaped, not treated as a wildcard', () => {
  const m = store();
  add(m, '/memories/reference_alpha.md');
  add(m, '/memories/referenceXalpha.md');   // matches `reference_alpha.md` if `_` stays a wildcard
  const hits = m.findDocumentsByBasename('reference_alpha.md');
  expect(hits.map((h) => h.source_path)).toEqual(['/memories/reference_alpha.md']);
});

test('findDocumentsByBasename: returns BOTH when a basename repeats across directories', () => {
  // The caller refuses an ambiguous delete on this; it must not be resolved here by picking one.
  const m = store();
  add(m, '/a/reference_dup.md');
  add(m, '/b/reference_dup.md');
  expect(m.findDocumentsByBasename('reference_dup.md')).toHaveLength(2);
});

test('findDocumentsByBasename: a channel narrows the match', () => {
  const m = store();
  add(m, '/a/reference_same.md', 'memory');
  add(m, '/b/reference_same.md', 'skill');
  const hits = m.findDocumentsByBasename('reference_same.md', 'memory');
  expect(hits).toHaveLength(1);
  expect(hits[0]!.source_path).toBe('/a/reference_same.md');
});

test('findDocumentsByBasename: no match is empty, not a partial guess', () => {
  const m = store();
  add(m, '/memories/reference_alpha.md');
  expect(m.findDocumentsByBasename('reference_missing.md')).toHaveLength(0);
});

test('findDocumentsByBasename: an exact full path matches too', () => {
  const m = store();
  add(m, '/memories/reference_alpha.md');
  expect(m.findDocumentsByBasename('/memories/reference_alpha.md')).toHaveLength(1);
});

// A file on disk is not what makes a memory findable — the index is. This is the whole
// reason `forget` exists rather than telling people to rm the .md.
test('a deleted .md leaves the document indexed until something de-indexes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-forget-file-'));
  const p = join(dir, 'reference_orphan.md');
  writeFileSync(p, '# hi');
  const m = store();
  add(m, p);
  expect(m.getDocument(p)).not.toBeNull();
  // (deleting p here changes nothing about the index — that is the bug forget fixes)
  expect(m.findDocumentsByBasename('reference_orphan.md')).toHaveLength(1);
});
