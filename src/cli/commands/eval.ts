// src/cli/commands/eval.ts — `captain-memo eval seed|run`.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { workerPost, workerHealthy } from '../client.ts';
import { parseGolden, seedFromRecallAudit } from '../../eval/golden.ts';
import { makeJudge, defaultAnthropicCall } from '../../eval/judge.ts';
import { runEval, formatReportTable, type EvalDoc } from '../../eval/run.ts';
import { postWithRetry } from '../../eval/retry.ts';

function dataDir(): string {
  return process.env.CAPTAIN_MEMO_DATA_DIR ?? join(homedir(), '.captain-memo');
}

export async function evalCommand(args: string[] = []): Promise<number> {
  const sub = args[0];
  if (sub === 'seed') {
    const limit = Number(args[1] ?? 50);
    const audit = readFileSync(join(dataDir(), 'recall-audit.jsonl'), 'utf8');
    for (const { query, count } of seedFromRecallAudit(audit, limit)) {
      console.log(`${String(count).padStart(4)}  ${query}`);
    }
    return 0;
  }
  if (sub === 'run') {
    if (!(await workerHealthy())) { console.error('worker not reachable — start it first'); return 1; }
    const setPath = args.find(a => a.endsWith('.jsonl')) ?? join(dataDir(), 'eval', 'golden.jsonl');
    const profilesArg = (args.find(a => a.startsWith('--profile=')) ?? '--profile=legacy,v2').split('=')[1]!;
    const profiles = profilesArg.split(',');
    const noJudge = args.includes('--no-judge');
    const golden = parseGolden(readFileSync(setPath, 'utf8'));

    const search = async (query: string, profile: string, topK: number): Promise<EvalDoc[]> => {
      const res = (await postWithRetry(() => workerPost('/search/all', { query, top_k: topK, rank_profile: profile }))) as {
        results: { doc_id: string; snippet: string; metadata: Record<string, unknown> }[];
      };
      return res.results.map(r => ({
        doc_id: r.doc_id,
        created_at_epoch: typeof r.metadata.created_at_epoch === 'number' ? r.metadata.created_at_epoch : 0,
        text: r.snippet,
      }));
    };
    const judge = noJudge ? undefined : makeJudge({ call: defaultAnthropicCall, cache: new Map() });

    const skipped = golden.filter(g => g.class !== 'temporal' || !g.entity).length;
    if (noJudge && skipped > 0) console.error(`note: --no-judge → ${skipped} non-temporal queries scored as 0 (mrr/ndcg/recall)`);

    const reports = await runEval({ golden, profiles, search, ...(judge ? { judge } : {}) });
    console.log(formatReportTable(reports));
    return 0;
  }
  console.error('usage: captain-memo eval seed [limit] | run [set.jsonl] [--profile=legacy,v2] [--no-judge]');
  return 2;
}
