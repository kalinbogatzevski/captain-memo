import { workerPost } from '../client.ts';

interface SkillDescriptor {
  name: string;
  description: string;
  source_agent: string;
  doc_id: string | null;
  warnings: string[];
}

export async function skillCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? 'list';
  if (sub !== 'list') {
    console.error('Usage: captain-memo skill list [--source AGENT] [--limit N] [--json]');
    return 2;
  }

  let sourceAgent: string | undefined;
  let limit = 100;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--source' && args[i + 1]) { sourceAgent = args[++i]; continue; }
    if (args[i] === '--limit' && args[i + 1]) {
      limit = Number(args[++i]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        console.error('--limit must be an integer from 1 to 500');
        return 2;
      }
    }
  }

  const body: Record<string, unknown> = { limit };
  if (sourceAgent) body.source_agent = sourceAgent;
  const result = await workerPost('/skills/list', body) as { skills: SkillDescriptor[]; count: number };
  if (args.includes('--json')) {
    console.log(JSON.stringify(result));
    return 0;
  }

  console.log('Virtual skills');
  console.log('---');
  for (const skill of result.skills) {
    console.log(`${skill.name}  [${skill.source_agent}]`);
    if (skill.description) console.log(`  ${skill.description}`);
    if (skill.doc_id) console.log(`  ${skill.doc_id}`);
    for (const warning of skill.warnings) console.log(`  ! ${warning}`);
  }
  console.log(`(${result.count} skill${result.count === 1 ? '' : 's'})`);
  return 0;
}
