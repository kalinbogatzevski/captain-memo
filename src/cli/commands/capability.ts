import { workerPost } from '../client.ts';

interface CapabilityDescriptor {
  name: string;
  description: string;
  version: string;
  source_agent: string;
  provider: string;
  operations: string[];
  interfaces: string[];
  doc_id: string | null;
}

function usage(): void {
  console.error('Usage: captain-memo capability list [--source AGENT] [--provider KIND] [--limit N] [--json]');
  console.error('       captain-memo capability recommend <task> [--source AGENT] [--provider KIND] [--limit N] [--json]');
}

export async function capabilityCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? 'list';
  if (sub !== 'list' && sub !== 'recommend') { usage(); return 2; }
  let sourceAgent: string | undefined;
  let provider: string | undefined;
  let limit = sub === 'list' ? 100 : 5;
  const taskParts: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--source' && args[i + 1]) { sourceAgent = args[++i]; continue; }
    if (args[i] === '--provider' && args[i + 1]) { provider = args[++i]; continue; }
    if (args[i] === '--limit' && args[i + 1]) {
      limit = Number(args[++i]);
      const max = sub === 'list' ? 500 : 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > max) {
        console.error(`--limit must be an integer from 1 to ${max}`);
        return 2;
      }
      continue;
    }
    if (args[i] === '--json') continue;
    if (sub === 'recommend') taskParts.push(args[i]!);
  }
  const body: Record<string, unknown> = sub === 'list'
    ? { limit }
    : { task: taskParts.join(' ').trim(), top_k: limit };
  if (sub === 'recommend' && !body.task) { usage(); return 2; }
  if (sourceAgent) body.source_agent = sourceAgent;
  if (provider) body.provider = provider;
  const result = await workerPost(
    sub === 'list' ? '/capabilities/list' : '/capabilities/recommend', body,
  ) as { capabilities: CapabilityDescriptor[]; count?: number };
  if (args.includes('--json')) { console.log(JSON.stringify(result)); return 0; }
  console.log(sub === 'list' ? 'Virtual capabilities' : 'Recommended virtual capabilities');
  console.log('---');
  for (const item of result.capabilities) {
    console.log(`${item.name}${item.version ? ` ${item.version}` : ''}  [${item.source_agent}; ${item.provider}]`);
    if (item.description) console.log(`  ${item.description}`);
    if (item.operations.length) console.log(`  operations: ${item.operations.join(', ')}`);
    if (item.interfaces.length) console.log(`  interfaces: ${item.interfaces.join(', ')}`);
    if (item.doc_id) console.log(`  ${item.doc_id}`);
  }
  console.log(`(${result.capabilities.length} capabilit${result.capabilities.length === 1 ? 'y' : 'ies'})`);
  return 0;
}
