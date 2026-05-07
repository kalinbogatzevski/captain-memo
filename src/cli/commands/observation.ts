import { workerGet, workerPost } from '../client.ts';

interface ObservationListItem {
  id: number;
  session_id: string;
  prompt_number: number;
  type: string;
  title: string;
  created_at_epoch: number;
}

export async function observationCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? 'help';

  if (sub === 'list') {
    let limit = 20;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--limit' && args[i + 1]) {
        limit = Number(args[i + 1]); i++;
      }
    }
    const data = await workerGet(`/observations/recent?limit=${limit}`) as { items: ObservationListItem[] };
    console.log('Recent observations');
    console.log('---');
    for (const o of data.items) {
      const date = new Date(o.created_at_epoch * 1000).toISOString().slice(0, 19);
      console.log(`${date}  [${o.type.padEnd(10)}]  ${o.title}`);
    }
    console.log(`(${data.items.length} rows)`);
    return 0;
  }

  if (sub === 'flush') {
    let session_id: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--session' && args[i + 1]) { session_id = args[i + 1]; i++; }
    }
    const body: Record<string, unknown> = { max: 500 };
    if (session_id) body.session_id = session_id;
    const result = await workerPost('/observation/flush', body) as {
      processed: number; observations_created: number; pending_remaining: number;
    };
    console.log(`processed: ${result.processed}`);
    console.log(`observations_created: ${result.observations_created}`);
    console.log(`pending_remaining: ${result.pending_remaining}`);
    return 0;
  }

  console.error('Usage: captain-memo observation <list|flush> [--limit N] [--session ID]');
  return 2;
}
