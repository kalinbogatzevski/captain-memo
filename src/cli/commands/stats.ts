import { workerGet } from '../client.ts';
import { renderStats, type StatsResponse } from '../stats-render.ts';

export async function statsCommand(args: string[] = []): Promise<number> {
  const stats = await workerGet('/stats') as StatsResponse;
  if (args.includes('--json')) {
    console.log(JSON.stringify(stats));
    return 0;
  }
  for (const line of renderStats(stats)) console.log(line);
  return 0;
}
