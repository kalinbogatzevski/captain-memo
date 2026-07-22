// `captain-memo capture <status|backfill>` — cross-AI observation capture.
//   status   → which sources are active on this host + how many sessions ingested
//   backfill → ingest pre-cutoff history now (POST /capture/backfill; the normal
//              tick only captures sessions finished AFTER capture was first enabled)

import { existsSync } from 'fs';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { DATA_DIR } from '../../shared/paths.ts';
import { workerGet, workerPost } from '../client.ts';

export async function captureCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? 'status';

  if (sub === 'backfill') {
    const r = await workerPost('/capture/backfill', {}) as {
      ingested: number; events: number; sources: string[]; detail?: string;
    };
    if (r.detail) { console.log(r.detail); return 0; }
    console.log(`Backfill complete: ingested ${r.ingested} session(s), ${r.events} event(s) from ${r.sources.join(', ') || '(none)'}.`);
    return 0;
  }

  if (sub === 'status') {
    let sources: string[] = [];
    let summarizerOff = false;
    try {
      const s = await workerGet('/stats') as { capture?: { sources?: string[] }; summarizer?: { enabled?: boolean } };
      sources = s.capture?.sources ?? [];
      summarizerOff = s.summarizer?.enabled === false;
    } catch { /* worker down — fall through to the on-disk counts */ }

    console.log('Cross-AI capture');
    console.log('---');
    const activeLine = sources.length
      ? sources.join(', ')
      : summarizerOff
        ? '(gated OFF — the summarizer is not running; run `captain-memo doctor`. Capture stays off until it works.)'
        : '(none detected — no codex/agy/gemini/kimi/opencode sessions on this host)';
    console.log(`active sources: ${activeLine}`);

    const dbPath = join(DATA_DIR, 'capture-state.db');
    if (!existsSync(dbPath)) { console.log('ingested:       (nothing yet)'); return 0; }
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.query(
        'SELECT source, COUNT(*) AS n, MAX(ingested_at_epoch) AS last FROM capture_ingested GROUP BY source ORDER BY source',
      ).all() as Array<{ source: string; n: number; last: number }>;
      if (rows.length === 0) { console.log('ingested:       (none yet)'); return 0; }
      console.log('ingested:');
      for (const r of rows) {
        console.log(`  ${r.source.padEnd(10)} ${r.n} session(s), last ${new Date(r.last * 1000).toISOString().slice(0, 19)}`);
      }
    } finally { db.close(); }
    return 0;
  }

  console.error('Usage: captain-memo capture <status|backfill>');
  return 2;
}
