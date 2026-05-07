import { workerGet, workerHealthy } from '../client.ts';

export async function statusCommand(): Promise<number> {
  const healthy = await workerHealthy();
  if (!healthy) {
    console.error('captain-memo worker: NOT RUNNING');
    console.error('  Start with: bun run worker:start');
    return 1;
  }
  const stats = await workerGet('/stats') as Record<string, unknown>;
  console.log('captain-memo worker: HEALTHY');
  console.log(`  total_chunks: ${stats.total_chunks}`);
  console.log(`  project_id:   ${stats.project_id}`);
  return 0;
}
