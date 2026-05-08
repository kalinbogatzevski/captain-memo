import {
  DEFAULT_WORKER_PORT, DEFAULT_VOYAGE_ENDPOINT,
  DEFAULT_SUMMARIZER_PROVIDER,
  DEFAULT_SUMMARIZER_MODEL, DEFAULT_SUMMARIZER_FALLBACKS,
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
    console.error('Usage: captain-memo config show');
    return 2;
  }

  const lines = [
    'captain-memo effective config',
    '---',
    `data_dir              ${DATA_DIR}`,
    `worker_port           ${process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT}`,
    `project_id            ${process.env.CAPTAIN_MEMO_PROJECT_ID ?? '(default)'}`,
    `embedder_endpoint       ${process.env.CAPTAIN_MEMO_EMBEDDER_ENDPOINT ?? DEFAULT_VOYAGE_ENDPOINT}`,
    `embedder_model          ${process.env.CAPTAIN_MEMO_EMBEDDER_MODEL ?? 'voyageai/voyage-4-nano'}`,
    `embedder_api_key        ${mask(process.env.CAPTAIN_MEMO_EMBEDDER_API_KEY)}`,
    `summarizer_provider   ${process.env.CAPTAIN_MEMO_SUMMARIZER_PROVIDER ?? DEFAULT_SUMMARIZER_PROVIDER}`,
    `summarizer_model      ${process.env.CAPTAIN_MEMO_SUMMARIZER_MODEL ?? DEFAULT_SUMMARIZER_MODEL}`,
    `summarizer_fallbacks  ${process.env.CAPTAIN_MEMO_SUMMARIZER_FALLBACKS ?? DEFAULT_SUMMARIZER_FALLBACKS.join(',')}`,
    `anthropic_api_key     ${mask(process.env.ANTHROPIC_API_KEY)}`,
    `openai_endpoint       ${process.env.CAPTAIN_MEMO_OPENAI_ENDPOINT ?? '(unset)'}`,
    `openai_api_key        ${mask(process.env.CAPTAIN_MEMO_OPENAI_API_KEY)}`,
    `hook_budget_tokens    ${process.env.CAPTAIN_MEMO_HOOK_BUDGET_TOKENS ?? DEFAULT_HOOK_BUDGET_TOKENS}`,
    `hook_timeout_ms       ${process.env.CAPTAIN_MEMO_HOOK_TIMEOUT_MS ?? DEFAULT_HOOK_TIMEOUT_MS}`,
    `observation_batch     ${process.env.CAPTAIN_MEMO_OBSERVATION_BATCH_SIZE ?? DEFAULT_OBSERVATION_BATCH_SIZE}`,
    `observation_tick_ms   ${process.env.CAPTAIN_MEMO_OBSERVATION_TICK_MS ?? DEFAULT_OBSERVATION_TICK_MS}`,
    `watch_memory          ${process.env.CAPTAIN_MEMO_WATCH_MEMORY ?? '(unset)'}`,
    `watch_skills          ${process.env.CAPTAIN_MEMO_WATCH_SKILLS ?? '(unset)'}`,
  ];
  for (const l of lines) console.log(l);
  return 0;
}
