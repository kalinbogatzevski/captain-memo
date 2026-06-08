import { workerGet } from '../client.ts';
import { renderStats, type StatsResponse, type RenderOpts } from '../stats-render.ts';

export async function statsCommand(args: string[] = []): Promise<number> {
  const stats = await workerGet('/stats') as StatsResponse;
  if (args.includes('--json')) {
    console.log(JSON.stringify(stats));
    return 0;
  }
  // --width N overrides terminal-width auto-detection. Useful when stdout is
  // piped (process.stdout.columns reads as 0) but you still want the wide
  // two-column layout — e.g. `captain-memo stats --width 140 | less -R`.
  let panelWidth: number | undefined;
  const widthIdx = args.indexOf('--width');
  if (widthIdx >= 0 && widthIdx + 1 < args.length) {
    const w = parseInt(args[widthIdx + 1]!, 10);
    if (Number.isFinite(w) && w >= 40) panelWidth = w;
  }
  const opts: RenderOpts = {};
  if (panelWidth !== undefined) opts.panelWidth = panelWidth;
  for (const line of renderStats(stats, opts)) console.log(line);
  return 0;
}
