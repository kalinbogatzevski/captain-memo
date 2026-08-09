// `captain-memo promote --shadow` — run the promotion judge over the real backlog and record what
// it WOULD have curated, writing nothing.
//
// WHY A CLI AND NOT JUST A TIMER: the background job promotes at most maxPerRun (5) per tick on a 6h
// interval. Against a measured 12,103 candidates that is ~605 days for one pass, and until v23 it
// never reached the backlog at all — declined rows were left unstamped, so each tick re-judged the
// same newest rows forever (migration v22 records the identical defect on the theme path: "279
// clusters considered, 279 declined, 0 written — the same 5 judged 56 times"). You cannot soak-test a
// judge you can only feed 20 rows a day. This drives it directly, at whatever pace you ask for.
//
// It loops ONE-SLICE-PER-REQUEST rather than holding a single long RPC: progress is visible, Ctrl-C
// loses nothing (the ledger records exactly how far it got), and no request outlives its deadline.

import { workerPost } from '../client.ts';

export interface PromoteArgs {
  shadow: boolean;
  limit: number;      // observations per judge call
  slices: number;     // how many judge calls to run
  minRecall: number;
  report: boolean;    // print the recorded keeps and exit, judging nothing
  reJudge: boolean;   // re-judge the rows already in the ledger (paired prompt comparison)
  sample: number;     // how many keeps to show in the report
}

class PromoteArgError extends Error {}

interface SliceResult {
  ok?: boolean;
  scanned?: number; promoted?: number; skipped?: number; errored?: number;
  shadowed?: number; judgeFailed?: boolean;
  totals?: { judged: number; kept: number; declined: number };
  error?: string; detail?: string;
}

function flagValue(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (v === undefined || v.startsWith('-')) throw new PromoteArgError(`${flag} requires a value`);
  return v;
}

function positiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new PromoteArgError(`${flag} needs a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

/** Pure parser — no I/O, so it unit-tests standalone (cf. parseRememberArgs). */
export function parsePromoteArgs(args: string[]): PromoteArgs {
  const out: PromoteArgs = { shadow: false, limit: 20, slices: 1, minRecall: 1, report: false, sample: 10, reJudge: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--shadow': out.shadow = true; break;
      case '--report': out.report = true; break;
      case '--re-judge': out.reJudge = true; break;
      case '--limit': out.limit = positiveInt(flagValue(args, i, '--limit'), '--limit'); i++; break;
      case '--slices': out.slices = positiveInt(flagValue(args, i, '--slices'), '--slices'); i++; break;
      case '--sample': out.sample = positiveInt(flagValue(args, i, '--sample'), '--sample'); i++; break;
      case '--min-recall': out.minRecall = Number(flagValue(args, i, '--min-recall')); i++; break;
      default: throw new PromoteArgError(`unknown flag: ${a}`);
    }
  }
  // LIVE promotion writes into curated memory. It is not reachable by forgetting a flag: this command
  // only ever runs in shadow, and arming the real job stays an explicit worker-env decision.
  if (!out.shadow && !out.report) {
    throw new PromoteArgError('--shadow is required (this command never writes; use it to evaluate the judge first)');
  }
  return out;
}

export async function promoteCommand(args: string[]): Promise<number> {
  let opts: PromoteArgs;
  try {
    opts = parsePromoteArgs(args);
  } catch (err) {
    console.error(`promote: ${err instanceof Error ? err.message : String(err)}`);
    console.error('usage: captain-memo promote --shadow [--slices N] [--limit N] [--min-recall N]');
    console.error('       captain-memo promote --report [--sample N]');
    return 1;
  }

  if (opts.report) return printReport(opts.sample);

  console.log(`Shadow promotion — ${opts.slices} slice(s) x ${opts.limit} observations, min-recall ${opts.minRecall}`);
  console.log('Nothing is written to curated memory; verdicts go to the shadow ledger.\n');

  let judged = 0, kept = 0, failures = 0;
  for (let s = 1; s <= opts.slices; s++) {
    let r: SliceResult;
    try {
      r = await workerPost('/promote/slice', {
        mode: 'shadow', limit: opts.limit, min_recall: opts.minRecall, re_judge: opts.reJudge,
      }) as SliceResult;
    } catch (err) {
      console.error(`  slice ${s}: request failed — ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (r.error) { console.error(`  slice ${s}: ${r.error}${r.detail ? ` — ${r.detail}` : ''}`); return 1; }

    // scanned 0 means the candidate pool is exhausted — stop rather than burn slices on nothing.
    if ((r.scanned ?? 0) === 0) { console.log(`  slice ${s}: no candidates left — stopping early`); break; }

    if (r.judgeFailed) {
      failures++;
      // Nothing was stamped, so these rows return next slice. Say so plainly: silence here is what
      // made the old `return []` indistinguishable from "declined everything".
      console.log(`  slice ${s}: JUDGE FAILED over ${r.scanned} — nothing recorded, rows will be retried`);
      continue;
    }
    const k = (r.scanned ?? 0) - (r.skipped ?? 0);
    judged += r.scanned ?? 0;
    kept += k;
    const pct = r.scanned ? Math.round((100 * k) / r.scanned) : 0;
    console.log(`  slice ${s}: judged ${r.scanned}, would promote ${k} (${pct}%), declined ${r.skipped}`
      + `   [ledger: ${r.totals?.judged ?? 0} judged, ${r.totals?.kept ?? 0} kept]`);
  }

  console.log(`\nThis run: ${judged} judged, ${kept} would be promoted`
    + `${judged ? ` (${Math.round((100 * kept) / judged)}%)` : ''}`
    + `${failures ? `, ${failures} judge failure(s)` : ''}`);
  console.log('Review what it chose:  captain-memo promote --report');
  return 0;
}

async function printReport(sample: number): Promise<number> {
  let r: { totals?: { judged: number; kept: number; declined: number }; keeps?: Array<{ observation_id: number; type: string; name: string; description: string }> };
  try {
    r = await workerPost('/promote/shadow-report', { sample }) as typeof r;
  } catch (err) {
    console.error(`promote --report failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const t = r.totals ?? { judged: 0, kept: 0, declined: 0 };
  console.log('Shadow promotion ledger');
  console.log('---');
  console.log(`  judged:   ${t.judged}`);
  console.log(`  would promote: ${t.kept}${t.judged ? ` (${Math.round((100 * t.kept) / t.judged)}%)` : ''}`);
  console.log(`  declined: ${t.declined}`);
  if (!r.keeps?.length) {
    console.log('\n(no keeps recorded yet — run `captain-memo promote --shadow --slices N`)');
    return 0;
  }
  console.log(`\nWhat it would have written (${r.keeps.length} of ${t.kept}):\n`);
  for (const k of r.keeps) {
    console.log(`  [${k.type}] ${k.name}   (obs ${k.observation_id})`);
    console.log(`      ${k.description}`);
  }
  console.log('\nThese are the entries a LIVE run would create. Judge the judge before arming it.');
  return 0;
}
