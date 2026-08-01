// src/cli/commands/consolidate.ts
//
// `captain-memo consolidate` — run a consolidation pass NOW, without waiting for the idle window.
//
// The passes are deliberately shy: they wait for no queued work, no live co-session, and thirty
// minutes of silence. That is right for a background job and wrong when you want to watch one
// happen, verify a fix, or clear a backlog before a demo.
//
// This overrides SCHEDULING ONLY. Protected rows stay untouchable, project/branch scope is still
// enforced, the cosine confirm and merge guard still run, the slice still yields the moment
// ingest arrives, and a pass already in flight is never doubled. Nothing here makes the machine
// braver — it only makes it prompt.

import { DEFAULT_WORKER_PORT } from '../../shared/paths.ts';
import { cyan, cyanBold, dim, gold, green, red } from '../../shared/ansi.ts';

const HELP = `captain-memo consolidate — run a consolidation pass now, skipping the idle wait

Usage:
  captain-memo consolidate [--semantic | --themes] [--for <30m|2h|900s>] [--json]

Options:
  (default)     Run both passes: semantic folding, then themes.
  --semantic    Folding only — collapse same-session restatements.
  --themes      Themes only — summarise cross-session clusters.
  --for <dur>   Keep forcing for a WINDOW rather than one pass: every scheduled tick skips
                the idle gate until it expires, so the backlog is worked down back-to-back.
                Accepts 45s / 30m / 2h. Capped at 4h. Reverts to idle-gated on its own.
  --json        Machine-readable output.
  -h, --help    Show this help.

Notes:
  - Skips the idle gate and NOTHING else. Every safety guard still applies, and everything a
    pass does is reversible (\`captain-memo dedup --undo\`, \`captain-memo theme undo <id>\`).
  - Waits for the pass to finish and reports what it did, rather than just that it started.
  - A pass already running is reported as busy rather than started twice.
`;

interface QmRun {
  id: number;
  job: string; rowsScanned: number; merges: number; skippedNoVector: number;
  abortedForIngest: boolean; errored: boolean;
}
interface ConsolidateResponse {
  started: string[]; busy: string[]; disabled: string[];
  /** Newest run id per pass BEFORE this request, so polling has a fixed point to beat. */
  before: Record<string, number>;
}

/** Poll /stats until each started pass records a run newer than the one it had before. */
async function awaitRuns(
  port: string, started: string[], before: Record<string, number>,
): Promise<Record<string, QmRun | null>> {
  const out: Record<string, QmRun | null> = {};
  const deadline = Date.now() + 30 * 60_000;
  const pending = new Set(started);
  while (pending.size > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    let stats: { qm?: { last_run: QmRun | null }; semantic?: { last_run: QmRun | null }; theme?: { last_run: QmRun | null } };
    try {
      const r = await fetch(`http://127.0.0.1:${port}/stats`, { signal: AbortSignal.timeout(15_000) });
      stats = await r.json() as typeof stats;
    } catch { continue; }        // a busy worker may refuse a read mid-pass; just try again
    for (const name of [...pending]) {
      const run = name === 'theme' ? stats.theme?.last_run : stats.semantic?.last_run;
      if (run && run.id > (before[name] ?? 0)) { out[name] = run; pending.delete(name); }
    }
  }
  for (const name of pending) out[name] = null;   // timed out; report honestly rather than guess
  return out;
}

export async function consolidateCommand(args: string[]): Promise<number> {
  let pass = 'all';
  let json = false;
  let forSec = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--for') {
      const raw = args[++i] ?? '';
      const m = /^(\d+)\s*([smh])?$/.exec(raw.trim());
      if (!m) { console.error(`--for expects a duration like 30m, 2h or 900s; got "${raw}"`); return 2; }
      const n = Number(m[1]);
      forSec = m[2] === 'h' ? n * 3600 : m[2] === 's' ? n : n * 60;   // bare number reads as minutes
      continue;
    }
    switch (a) {
      case '--semantic': pass = 'semantic'; break;
      case '--themes': case '--theme': pass = 'theme'; break;
      case '--json': json = true; break;
      case '-h': case '--help': console.log(HELP); return 0;
      default:
        console.error(`Unknown flag: ${a}`);
        console.error(HELP);
        return 2;
    }
  }

  const port = process.env.CAPTAIN_MEMO_WORKER_PORT ?? String(DEFAULT_WORKER_PORT);
  const url = `http://127.0.0.1:${port}/consolidate?pass=${pass}${forSec > 0 ? `&for=${forSec}` : ''}`;
  if (!json) {
    console.log(dim(forSec > 0
      ? `Forcing ${pass === 'all' ? 'both passes' : pass} for the next ${Math.round(forSec / 60)} min — waiting on the first run…`
      : `Running ${pass === 'all' ? 'both passes' : pass}… (waiting for it to finish…)`));
  }

  let res: Response;
  try {
    // A forced pass is a whole-corpus scan plus, for themes, a model call per cluster. Bun's
    // default fetch timeout cut this off long before the worker finished and reported the
    // connection as unreachable — which reads as "the worker is down" when it is mid-work.
    res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    // Name the failure. "Unreachable" swallowed a timeout and a connection reset alike, which
    // sent me looking for a dead worker that was in fact mid-pass.
    const why = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`${red('✗')} Could not complete the request on port ${port} — ${why}`);
    console.error(dim('  The pass may still be running; check `captain-memo stats`.'));
    return 1;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`${red('✗')} ${res.status} ${body.slice(0, 200)}`);
    return 1;
  }
  const data = await res.json() as ConsolidateResponse;
  const runs = data.started.length > 0
    ? await awaitRuns(port, data.started, data.before ?? {})
    : {};
  if (json) { console.log(JSON.stringify({ ...data, runs }, null, 2)); return 0; }

  for (const name of data.disabled) {
    console.log(`${gold('▸')} ${name} ${dim('is switched off — nothing to run')}`);
  }
  for (const name of data.busy) {
    console.log(`${gold('▸')} ${name} ${dim('was already running; left alone')}`);
  }
  if (data.started.length === 0 && data.disabled.length === 0 && data.busy.length === 0) {
    console.log(dim('Nothing to run.'));
    return 0;
  }
  for (const name of data.started) {
    const r = runs[name];
    if (!r) { console.log(`${gold('▸')} ${name} ${dim('started, still running — check `captain-memo stats`')}`); continue; }
    // The two passes count different things: folding archives rows, theming writes themes and
    // records how many clusters the judge refused. Labelling them the same would misread both.
    const what = name === 'theme'
      ? `${cyanBold(String(r.merges))} theme(s) written ${dim(`· ${r.rowsScanned} cluster(s) considered · ${r.skippedNoVector} declined`)}`
      : `${cyanBold(String(r.merges))} row(s) folded ${dim(`· ${r.rowsScanned} group(s) scanned`)}`;
    const flags = [
      r.abortedForIngest ? gold('aborted for ingest') : '',
      r.errored ? red('errored') : '',
    ].filter(Boolean).join(' ');
    console.log(`${green('✓')} ${cyan(name.padEnd(9))} ${what}${flags ? '  ' + flags : ''}`);
  }
  console.log('');
  if (forSec > 0) {
    console.log(dim(`  Still forcing for ~${Math.round(forSec / 60)} min; later passes run in the background.`));
  }
  console.log(dim('  captain-memo stats           to see the Housekeeping panel'));
  console.log(dim('  captain-memo theme list      to read what was written'));
  return 0;
}
