import { workerGet, workerHealthy } from '../client.ts';

export async function statusCommand(args: string[] = []): Promise<number> {
  const json = args.includes('--json');
  const healthy = await workerHealthy();
  if (!healthy) {
    if (json) {
      console.log(JSON.stringify({ healthy: false }));
    } else {
      console.error('captain-memo worker: NOT RUNNING');
      console.error('  Start with: bun run worker:start');
    }
    return 1;
  }
  const stats = await workerGet('/stats') as Record<string, unknown>;
  if (json) {
    console.log(JSON.stringify({ healthy: true, total_chunks: stats.total_chunks, project_id: stats.project_id }));
    return 0;
  }
  console.log('captain-memo worker: HEALTHY');
  console.log(`  total_chunks: ${stats.total_chunks}`);
  console.log(`  project_id:   ${stats.project_id}`);
  return 0;
}
