import { workerPost } from '../client.ts';

export async function reindexCommand(args: string[]): Promise<number> {
  let channel: 'memory' | 'skill' | 'observation' | 'all' = 'all';
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--channel') {
      const next = args[++i];
      if (!next || !['memory', 'skill', 'observation', 'all'].includes(next)) {
        console.error(`Invalid --channel value: ${next ?? '(missing)'}`);
        return 2;
      }
      channel = next as typeof channel;
    } else if (arg === '--force') {
      force = true;
    } else {
      console.error(`Unknown reindex flag: ${arg}`);
      return 2;
    }
  }

  const result = await workerPost('/reindex', { channel, force }) as {
    indexed: number;
    skipped: number;
    errors: number;
  };
  console.log('Reindex complete:');
  console.log(`  indexed: ${result.indexed}`);
  console.log(`  skipped: ${result.skipped}`);
  console.log(`  errors:  ${result.errors}`);
  return result.errors > 0 ? 1 : 0;
}
