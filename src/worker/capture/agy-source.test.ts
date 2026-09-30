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
  expect(refs.find((r) => r.sessionId === 'sess1')!.marker).toBe('1:0'); // content marker: 1 step, max idx 0
});

test('agy discover: marker is STABLE across repeated reads (no dup re-ingestion loop)', () => {
  // Regression: the marker used to fold in the -wal/-shm mtime+size. But a readonly
  // open of a WAL-mode db CREATES those sidecars, so every discover() bumped the
  // marker and the driver re-ingested the same session each quiesce window (a
  // duplicate obs/min from one stale session). The content marker must not move.
  const dir = mkdtempSync(join(tmpdir(), 'cm-agy-stable-'));
  const dbPath = join(dir, 'sess1.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER, step_payload BLOB)');
  db.query('INSERT INTO steps (idx, step_payload) VALUES (?, ?)').run(0, Uint8Array.from(Buffer.from('hello agy')));
  db.close();

  const src = createAgySource({ projectId: 'p', dir, quiesceMs: 0, now: () => Date.now() + 10_000 });
  const m1 = src.discover().find((r) => r.sessionId === 'sess1')!.marker; // this open creates -wal/-shm
  const m2 = src.discover().find((r) => r.sessionId === 'sess1')!.marker; // sidecars now exist + touched
  const m3 = src.discover().find((r) => r.sessionId === 'sess1')!.marker;
  expect(m1).toBe('1:0');
  expect(m2).toBe(m1); // unchanged despite our own reads touching the sidecars
  expect(m3).toBe(m1);
});

test('agy extract: stopping at the event cap yields exactly what reading every step did', () => {
  // The pre-cap algorithm, verbatim: every step's printable text, joined, consecutive duplicate lines dropped,
  // then the first MAX_EVENTS windows of SUMMARY_MAX chars.
  const reference = (blobs: Uint8Array[]): string[] => {
    const out: string[] = [];
    for (const line of blobs.map((b) => extractPrintable(b)).join('\n').split('\n')) {
      const t = line.trim();
      if (t && t !== out[out.length - 1]) out.push(t);
    }
    const text = out.join('\n');
    const chunks: string[] = [];
    for (let i = 0; i < text.length && chunks.length < 8; i += 2000) chunks.push(text.slice(i, i + 2000));
    return chunks;
  };
  for (const steps of [1, 3, 7, 8, 9, 40, 400]) {
    const dir = mkdtempSync(join(tmpdir(), 'cm-agy-cap-'));
    const path = join(dir, 's.db');
    const db = new Database(path);
    db.exec('CREATE TABLE steps (idx INTEGER, step_payload BLOB)');
    const blobs: Uint8Array[] = [];
    for (let i = 0; i < steps; i++) {
      // the prompt repeated across steps (deduped across the row boundary) and ~2 KB of new text per step
      const body = `  the same prompt  \n${`step ${i} output ${'x'.repeat(i % 50)}\n`.repeat(40)}`;
      blobs.push(Uint8Array.from([0x08, 0x0e, ...Buffer.from(body), 0x00]));
    }
    db.transaction(() => { blobs.forEach((b, i) => db.query('INSERT INTO steps VALUES (?, ?)').run(i, b)); })();
    db.close();
    const events = createAgySource({ projectId: 'p', dir }).extract({ sessionId: 's', path, marker: 'm', mtimeEpoch: 1 });
    expect(events.map((e) => e.tool_result_summary)).toEqual(reference(blobs));
  }
});

test('agy enabled(): default on, off via env=0', () => {
  expect(createAgySource({ projectId: 'p', env: {} }).enabled()).toBe(true);
  expect(createAgySource({ projectId: 'p', env: { CAPTAIN_MEMO_CAPTURE_AGY: '0' } }).enabled()).toBe(false);
});
