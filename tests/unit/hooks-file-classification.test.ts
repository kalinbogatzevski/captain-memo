import { test, expect } from 'bun:test';
import { extractFiles } from '../../src/hooks/post-tool-use.ts';

// files_modified was empty on ALL 122,885 observations in a live corpus. The classifier decided
// "modification?" by sniffing for a `success` key in the tool RESPONSE — which Claude Code's Edit/Write
// responses do not carry — so every file-touching tool was recorded as a read. Measured in the live
// queue: 198 of 400 events had files_read, zero had files_modified.
//
// The tool NAME is in the payload and is authoritative: Edit modifies, Read reads. Sniffing the
// response shape was inferring something already stated.
//
// This is not cosmetic. "Did this change anything, or merely look at something?" is the strongest
// available ingest-time signal for whether an observation is worth keeping — and it was the one field
// that could have told "Fixed the race in dream-stats" from "Located SendMessage tool".
test('Edit/Write/MultiEdit count as MODIFIED even when the response has no success flag', () => {
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    const r = extractFiles(tool, { file_path: '/a/b.ts' }, { ok: true });
    expect(r.modified).toEqual(['/a/b.ts']);
    expect(r.read).toEqual([]);
  }
});

test('Read/Grep/Glob count as READ', () => {
  for (const tool of ['Read', 'Grep', 'Glob']) {
    const r = extractFiles(tool, { file_path: '/a/b.ts' }, {});
    expect(r.read).toEqual(['/a/b.ts']);
    expect(r.modified).toEqual([]);
  }
});

test('notebook_path is a modification regardless of tool', () => {
  expect(extractFiles('NotebookEdit', { notebook_path: '/n.ipynb' }, {}).modified).toEqual(['/n.ipynb']);
});

test('an unknown tool with a file_path degrades to READ, never to a false modification', () => {
  const r = extractFiles('SomeFutureTool', { file_path: '/a/b.ts' }, {});
  expect(r.read).toEqual(['/a/b.ts']);
  expect(r.modified).toEqual([]);
});

test('no file_path yields nothing at all', () => {
  expect(extractFiles('Bash', { command: 'ls' }, {})).toEqual({ read: [], modified: [] });
});
