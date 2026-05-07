import { workerGet } from '../client.ts';

export async function statsCommand(): Promise<number> {
  const stats = await workerGet('/stats') as {
    total_chunks: number;
    by_channel: Record<string, number>;
    project_id: string;
    embedder: { model: string; endpoint: string };
  };
  console.log('aelita-mcp corpus statistics');
  console.log('---');
  console.log(`Project:      ${stats.project_id}`);
  console.log(`Total chunks: ${stats.total_chunks}`);
  console.log('By channel:');
  for (const [channel, count] of Object.entries(stats.by_channel)) {
    console.log(`  ${channel.padEnd(15)} ${count}`);
  }
  console.log(`Embedder:     ${stats.embedder.model} @ ${stats.embedder.endpoint}`);
  return 0;
}
