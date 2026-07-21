import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { createAgySource, extractPrintable } from './agy-source.ts';

test('extractPrintable recovers ASCII runs from a protobuf-ish blob', () => {
  // printable text bracketed and separated by protobuf framing bytes
  const bytes = [0x08, 0x0e, 0x20, ...Buffer.from('read notes.txt and summarize'), 0x00, 0x01, ...Buffer.from('MARK_7f3c'), 0xff];
  const text = extractPrintable(Uint8Array.from(bytes));
  expect(text).toContain('read notes.txt and summarize');
  expect(text).toContain('MARK_7f3c');
});

test('agy extract: reads steps blobs, stamps origin_agent=agy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-agy-'));
  const path = join(dir, 'aaaa-bbbb.db');
  const db = new Database(path);
  db.exec('CREATE TABLE steps (idx INTEGER, step_payload BLOB)');
  const blob = Uint8Array.from([0x08, 0x0e, ...Buffer.from('write a one-line summary to summary.txt MARK_7f3c'), 0x00]);
  db.query('INSERT INTO steps (idx, step_payload) VALUES (?, ?)').run(0, blob);
  db.close();

  const src = createAgySource({ projectId: 'proj' });
  const events = src.extract({ sessionId: 'aaaa-bbbb', path, marker: 'm', mtimeEpoch: 123 });

  expect(events.length).toBeGreaterThanOrEqual(1);
  expect(events[0]!.origin_agent).toBe('agy');
  expect(events[0]!.session_id).toBe('aaaa-bbbb');
  expect(events[0]!.prompt_number).toBe(1);
  expect(events[0]!.tool_result_summary).toContain('MARK_7f3c');
});

test('agy discover: captures a quiescent session even with a lingering -wal (agy never checkpoints on exit)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-agy-disc-'));
  const dbPath = join(dir, 'sess1.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER, step_payload BLOB)');
  db.query('INSERT INTO steps (idx, step_payload) VALUES (?, ?)').run(0, Uint8Array.from(Buffer.from('hello agy')));
  db.close();
  writeFileSync(dbPath + '-wal', 'lingering wal bytes'); // agy leaves this behind after the session ends

  const src = createAgySource({ projectId: 'p', dir, quiesceMs: 0, now: () => Date.now() + 10_000 });
  const refs = src.discover();
  expect(refs.map((r) => r.sessionId)).toContain('sess1');            // discovered DESPITE the -wal
  expect(refs.find((r) => r.sessionId === 'sess1')!.marker).toMatch(/:\d+:\d+$/); // marker folds in the wal sig
});

test('agy enabled(): default on, off via env=0', () => {
  expect(createAgySource({ projectId: 'p', env: {} }).enabled()).toBe(true);
  expect(createAgySource({ projectId: 'p', env: { CAPTAIN_MEMO_CAPTURE_AGY: '0' } }).enabled()).toBe(false);
});
