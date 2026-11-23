import { workerGet, workerHealth } from '../client.ts';
import { MANUAL_START_HINT } from '../../shared/worker-control.ts';

export async function statusCommand(args: string[] = []): Promise<number> {
  const json = args.includes('--json');
  const health = await workerHealth();
  if (!health.healthy) {
    if (json) {
      console.log(JSON.stringify({ healthy: false, reason: health.reason ?? null }));
    } else {
      console.error(`captain-memo worker: NOT RUNNING (${health.reason ?? 'unknown'})`);
      console.error(`  Start:     ${MANUAL_START_HINT}`);
      console.error('  Diagnose:  captain-memo doctor');
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
