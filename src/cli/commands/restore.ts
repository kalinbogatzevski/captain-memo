import { workerPost } from '../client.ts';

/** `captain-memo restore <id>` — re-surface a sunk (dormant/archived) observation
 *  back to active. The per-row reversal for Tide tiering; idempotent on active rows. */
export async function restoreCommand(args: string[]): Promise<number> {
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id <= 0) {
    console.error('Usage: captain-memo restore <observation-id>');
    console.error('  Re-surfaces a sunk (dormant/archived) observation back to active.');
    console.error('  List sunk rows with: captain-memo observation sunk [--archived]');
    return 2;
  }
  const res = await workerPost('/observation/restore', { id }) as
    { id: number; result: 'restored' | 'already_active' | 'not_found' };
  if (res.result === 'restored') {
    console.log(`✓ restored observation ${res.id} → active`);
    return 0;
  }
  if (res.result === 'already_active') {
    console.log(`observation ${res.id} was already active (nothing to restore)`);
    return 0;
  }
  console.error(`✗ no observation with id ${res.id}`);
  return 1;
}
