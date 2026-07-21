import { test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { createOpencodeSource } from './opencode-source.ts';

function fixtureDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'cm-oc-')), 'opencode.db');
  const db = new Database(path);
  db.exec(`
    CREATE TABLE session(id TEXT, project_id TEXT, directory TEXT, title TEXT, time_created INT, time_updated INT, time_archived INT);
    CREATE TABLE message(id TEXT, session_id TEXT, time_created INT, data TEXT);
    CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INT, data TEXT);
  `);
  db.query('INSERT INTO session (id, project_id, time_created, time_updated) VALUES (?,?,?,?)').run('ses1', 'p', 1000, 2000);
  db.query('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)').run('m1', 'ses1', 1000, JSON.stringify({ role: 'user' }));
  db.query('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)').run('m2', 'ses1', 1100, JSON.stringify({ role: 'assistant' }));
  db.query('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)').run('p1', 'm1', 'ses1', 1000, JSON.stringify({ type: 'text', text: 'hello opencode' }));
  db.query('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)').run('p2', 'm2', 'ses1', 1100, JSON.stringify({ type: 'text', text: 'hi there' }));
  db.query('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)').run('p3', 'm2', 'ses1', 1150, JSON.stringify({ type: 'tool', tool: 'bash', state: { input: { command: 'ls' } } }));
  db.close();
  return path;
}

test('opencode extract: reconstructs a session from message+part, origin_agent=opencode', () => {
  const dbPath = fixtureDb();
  const src = createOpencodeSource({ projectId: 'proj', dbPath });
  const events = src.extract({ sessionId: 'ses1', path: dbPath, marker: '2000', mtimeEpoch: 2 });

  expect(events).toHaveLength(1); // one user turn
  const e = events[0]!;
  expect(e.origin_agent).toBe('opencode');
  expect(e.session_id).toBe('ses1');
  expect(e.tool_input_summary).toBe('hello opencode');
  expect(e.tool_result_summary).toContain('assistant: hi there');
  expect(e.tool_result_summary).toContain('bash(');
});

test('opencode discover: lists quiescent sessions from the shared db', () => {
  const dbPath = fixtureDb();
  const src = createOpencodeSource({ projectId: 'proj', dbPath, quiesceMs: 0, now: () => 10_000_000 });
  const refs = src.discover();
  expect(refs.map((r) => r.sessionId)).toContain('ses1');
  expect(refs[0]!.marker).toBe('2000');
});
