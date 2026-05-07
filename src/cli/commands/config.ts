import {
  DEFAULT_WORKER_PORT, DEFAULT_VOYAGE_ENDPOINT,
  DEFAULT_SUMMARIZER_PROVIDER,
  DEFAULT_HAIKU_MODEL, DEFAULT_HAIKU_FALLBACKS,
  DEFAULT_HOOK_BUDGET_TOKENS,
  DEFAULT_HOOK_TIMEOUT_MS, DEFAULT_OBSERVATION_BATCH_SIZE,
  DEFAULT_OBSERVATION_TICK_MS, DATA_DIR,
} from '../../shared/paths.ts';

function mask(secret: string | undefined): string {
  if (!secret) return '(unset)';
  if (secret.length <= 8) return '***';
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

export async function configCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? 'show';
  if (sub !== 'show') {
    console.error('Usage: aelita-mcp config show');
    return 2;
  }

  const lines = [
    'aelita-mcp effective config',
    '---',
    `data_dir              ${DATA_DIR}`,
    `worker_port           ${process.env.AELITA_MCP_WORKER_PORT ?? DEFAULT_WORKER_PORT}`,
    `project_id            ${process.env.AELITA_MCP_PROJECT_ID ?? '(default)'}`,
    `voyage_endpoint       ${process.env.AELITA_MCP_VOYAGE_ENDPOINT ?? DEFAULT_VOYAGE_ENDPOINT}`,
    `voyage_model          ${process.env.AELITA_MCP_VOYAGE_MODEL ?? 'voyage-4-nano'}`,
    `voyage_api_key        ${mask(process.env.AELITA_MCP_VOYAGE_API_KEY)}`,
    `summarizer_provider   ${process.env.AELITA_MCP_SUMMARIZER_PROVIDER ?? DEFAULT_SUMMARIZER_PROVIDER}`,
    `haiku_model           ${process.env.AELITA_MCP_HAIKU_MODEL ?? DEFAULT_HAIKU_MODEL}`,
    `haiku_fallbacks       ${process.env.AELITA_MCP_HAIKU_FALLBACKS ?? DEFAULT_HAIKU_FALLBACKS.join(',')}`,
    `anthropic_api_key     ${mask(process.env.ANTHROPIC_API_KEY)}`,
    `openai_endpoint       ${process.env.AELITA_MCP_OPENAI_ENDPOINT ?? '(unset)'}`,
    `openai_api_key        ${mask(process.env.AELITA_MCP_OPENAI_API_KEY)}`,
    `hook_budget_tokens    ${process.env.AELITA_MCP_HOOK_BUDGET_TOKENS ?? DEFAULT_HOOK_BUDGET_TOKENS}`,
    `hook_timeout_ms       ${process.env.AELITA_MCP_HOOK_TIMEOUT_MS ?? DEFAULT_HOOK_TIMEOUT_MS}`,
    `observation_batch     ${process.env.AELITA_MCP_OBSERVATION_BATCH_SIZE ?? DEFAULT_OBSERVATION_BATCH_SIZE}`,
    `observation_tick_ms   ${process.env.AELITA_MCP_OBSERVATION_TICK_MS ?? DEFAULT_OBSERVATION_TICK_MS}`,
    `watch_memory          ${process.env.AELITA_MCP_WATCH_MEMORY ?? '(unset)'}`,
    `watch_skills          ${process.env.AELITA_MCP_WATCH_SKILLS ?? '(unset)'}`,
  ];
  for (const l of lines) console.log(l);
  return 0;
}
