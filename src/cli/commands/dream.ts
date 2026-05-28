// src/cli/commands/dream.ts
//
// `captain-memo dream --dry-run` — preview Local Dreaming cluster output
// without writing anything or calling Haiku.
//
// v1 ships dry-run only. The real write-path (theme insertion + member
// archival + summarization) lands once the dry-run output has been validated
// against a few days of real co-retrieval data. See:
// docs/specs/2026-05-27-local-dreaming-design.md.

import { loadDreamInputs } from '../../dreaming/load.ts';
import { dryRun, type DreamRunOpts } from '../../dreaming/orchestrate.ts';
import { renderReport } from '../../dreaming/report.ts';

const HELP = `captain-memo dream — Local Dreaming preview

Usage:
  captain-memo dream --dry-run [options]

Options:
  --dry-run            Required in v1; the write path is not yet implemented.
  --since <Nd>         Look-back window. Default 14d. Examples: 7d, 30d, 90d.
  --eps <float>        DBSCAN distance threshold (0..1). Default 0.35.
  --min-pts <int>      DBSCAN minimum points per cluster. Default 3.
  --tau-days <int>     Temporal decay constant in days. Default 7.
  --project <id>       Limit to one project_id. Default: all projects.
  --json               Emit JSON instead of the formatted report.
  -h, --help           Show this help.

Notes:
  - Reads observations.db, meta.sqlite3, and recall-audit.jsonl directly.
  - Co-retrieval signal requires CAPTAIN_MEMO_RECALL_AUDIT=1 to have been on
    during the look-back window.
  - No DB writes. No Haiku calls. No worker contact. Safe to run anytime.
`;

function parseSince(s: string): number {
  // Accept "Nd" (days) only for v1. Easy to extend to h/w later if needed.
  const m = /^(\d+)d$/.exec(s);
  if (!m) throw new Error(`--since expects "<N>d" (e.g. 14d); got "${s}"`);
  return parseInt(m[1]!, 10);
}

export async function dreamCommand(args: string[]): Promise<number> {
  let dryRunFlag = false;
  let sinceDays = 14;
  let eps = 0.35;
  let minPts = 3;
  let tauDays = 7;
  let projectId: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--dry-run':  dryRunFlag = true; break;
      case '--since':    sinceDays = parseSince(args[++i] ?? ''); break;
      case '--eps':      eps = parseFloat(args[++i] ?? ''); break;
      case '--min-pts':  minPts = parseInt(args[++i] ?? '', 10); break;
      case '--tau-days': tauDays = parseInt(args[++i] ?? '', 10); break;
      case '--project':  projectId = args[++i]; break;
      case '--json':     json = true; break;
      case '-h': case '--help':
        console.log(HELP);
        return 0;
      default:
        console.error(`Unknown flag: ${a}`);
        console.error(HELP);
        return 2;
    }
  }

  if (!dryRunFlag) {
    console.error('captain-memo dream: v1 only supports --dry-run (no write path yet).');
    console.error('Pass --dry-run to preview clusters.');
    return 2;
  }
  if (!Number.isFinite(eps) || eps <= 0 || eps >= 1) {
    console.error(`--eps must be in (0, 1); got ${eps}`);
    return 2;
  }
  if (!Number.isInteger(minPts) || minPts < 2) {
    console.error(`--min-pts must be an integer ≥ 2; got ${minPts}`);
    return 2;
  }

  const sinceEpoch = Math.floor(Date.now() / 1000) - sinceDays * 86400;
  const opts: DreamRunOpts = {
    eps,
    minPts,
    tauSeconds: tauDays * 86400,
  };

  const inputs = await loadDreamInputs(sinceEpoch, projectId);
  const report = dryRun(inputs, opts);

  if (json) {
    // Replace observation arrays with id-only summaries for compact JSON.
    const compact = {
      total: report.total,
      withoutCoRetrieval: report.withoutCoRetrieval,
      weights: report.weights,
      opts: report.opts,
      clusters: report.clusters.map(c => ({
        member_ids: c.members.map(m => m.id),
        span: c.span,
        coOccurrenceWeight: c.coOccurrenceWeight,
      })),
      noise_ids: report.noise.map(o => o.id),
    };
    console.log(JSON.stringify(compact, null, 2));
  } else {
    for (const line of renderReport(report)) console.log(line);
  }
  return 0;
}
