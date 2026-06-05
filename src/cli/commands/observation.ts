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

  if (sub === 'sunk') {
    let state: 'dormant' | 'archived' = 'dormant';
    let limit = 50;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--archived') state = 'archived';
      else if (args[i] === '--ebbed' || args[i] === '--dormant') state = 'dormant';
      else if (args[i] === '--limit' && args[i + 1]) { limit = Number(args[i + 1]); i++; }
    }
    const data = await workerGet(`/observations/by-tide-state?state=${state}&limit=${limit}`) as {
      items: Array<{ id: number; type: string; title: string; tide_state_changed_at: number | null }>;
    };
    console.log(state === 'archived' ? 'Archived (sunk) observations' : 'Ebbed (dormant) observations');
    console.log('---');
    for (const o of data.items) {
      const when = o.tide_state_changed_at
        ? new Date(o.tide_state_changed_at * 1000).toISOString().slice(0, 19) : '—';
      console.log(`${String(o.id).padStart(7)}  ${when}  [${o.type.padEnd(10)}]  ${o.title}`);
    }
    console.log(`(${data.items.length} rows)  ·  restore one with: captain-memo restore <id>`);
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

  console.error('Usage: captain-memo observation <list|sunk|flush> [--limit N] [--session ID] [--archived|--ebbed]');
  return 2;
}
