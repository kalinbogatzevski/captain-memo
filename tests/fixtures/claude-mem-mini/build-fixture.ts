// Run via: bun tests/fixtures/claude-mem-mini/build-fixture.ts
// Builds a small claude-mem-shaped SQLite at ./claude-mem-fixture.db
import { Database } from 'bun:sqlite';
import { existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, 'claude-mem-fixture.db');
if (existsSync(target)) unlinkSync(target);

const db = new Database(target);
db.exec(`
  CREATE TABLE sdk_sessions (
    id INTEGER PRIMARY KEY, content_session_id TEXT UNIQUE NOT NULL,
    memory_session_id TEXT UNIQUE, project TEXT NOT NULL,
    user_prompt TEXT, started_at TEXT NOT NULL, started_at_epoch INTEGER NOT NULL,
    completed_at TEXT, completed_at_epoch INTEGER,
    status TEXT NOT NULL DEFAULT 'completed'
  );
  CREATE TABLE observations (
    id INTEGER PRIMARY KEY, memory_session_id TEXT NOT NULL, project TEXT NOT NULL,
    text TEXT, type TEXT NOT NULL, title TEXT, subtitle TEXT,
    facts TEXT, narrative TEXT, concepts TEXT,
    files_read TEXT, files_modified TEXT,
    prompt_number INTEGER, discovery_tokens INTEGER DEFAULT 0,
    created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL
  );
  CREATE TABLE session_summaries (
    id INTEGER PRIMARY KEY, memory_session_id TEXT NOT NULL, project TEXT NOT NULL,
    request TEXT, investigated TEXT, learned TEXT,
    completed TEXT, next_steps TEXT,
    files_read TEXT, files_edited TEXT, notes TEXT,
    prompt_number INTEGER, discovery_tokens INTEGER DEFAULT 0,
    created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL
  );
`);

db.run(
  `INSERT INTO sdk_sessions(content_session_id, memory_session_id, project,
                            started_at, started_at_epoch, completed_at, completed_at_epoch, status)
   VALUES ('content-1','mem-1','erp-platform','2026-05-01',1730000000,
           '2026-05-01',1730003600,'completed')`,
);

interface ObsCase {
  id: number;
  type: string;
  title: string;
  narrative: string;
  facts?: string[];
  files_read?: string[];
  files_modified?: string[];
}

const obsCases: ObsCase[] = [
  {
    id: 1,
    type: 'discovery',
    title: 'GeoMap audit start',
    narrative: 'Looking at geomap.',
    facts: ['Has 10 areas', 'Uses geo_* tables'],
    files_read: ['geomap.php'],
  },
  {
    id: 2,
    type: 'bugfix',
    title: 'GLAB#367 fixed',
    narrative: 'Locked field showed wrong default.',
    facts: ['Root cause: hardcoded fallback'],
    files_modified: ['form.php'],
  },
  {
    id: 3,
    type: 'feature',
    title: 'Field PWA scan',
    narrative: 'Scan SN flow.',
    facts: [],
  },
  {
    id: 4,
    type: 'change',
    title: '',
    narrative: '',
    facts: ['empty narrative + empty title still has facts'], // edge
  },
  {
    id: 5,
    type: 'decision',
    title: 'Chose sqlite-vec',
    narrative: 'Chroma was too heavy.',
    facts: ['~2GB', 'subprocess management'],
  },
];

for (const c of obsCases) {
  db.run(
    `INSERT INTO observations(id, memory_session_id, project, type, title, narrative,
                              facts, concepts, files_read, files_modified,
                              prompt_number, created_at, created_at_epoch)
     VALUES (?, 'mem-1', 'erp-platform', ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
    [
      c.id,
      c.type,
      c.title,
      c.narrative,
      JSON.stringify(c.facts ?? []),
      JSON.stringify([]),
      JSON.stringify(c.files_read ?? []),
      JSON.stringify(c.files_modified ?? []),
      c.id,
      1730000000000 + c.id * 1000,
    ],
  );
}

db.run(
  `INSERT INTO session_summaries(id, memory_session_id, project, request, investigated,
                                  learned, completed, next_steps, notes,
                                  prompt_number, created_at, created_at_epoch)
   VALUES (100,'mem-1','erp-platform','find bug','grepped','RTFM','fixed','deploy','',
           10, '', 1730000099000)`,
);
db.close();
console.log(`Wrote ${target}`);
