import { readStdinJson, writeStdout, workerFetch } from './shared.ts';
import { DEFAULT_HOOK_TIMEOUT_MS, ENV_HOOK_TIMEOUT_MS } from '../shared/paths.ts';
import type { EnvelopePayload } from '../shared/types.ts';

interface UserPromptSubmitPayload {
  prompt?: string;
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
}

async function main(): Promise<void> {
  let payload: UserPromptSubmitPayload = {};
  try {
    payload = await readStdinJson<UserPromptSubmitPayload>();
  } catch {
    return;
  }
  const prompt = payload.prompt ?? '';
  const timeoutMs = Number(process.env[ENV_HOOK_TIMEOUT_MS] ?? DEFAULT_HOOK_TIMEOUT_MS);

  const result = await workerFetch<EnvelopePayload>('/inject/context', {
    method: 'POST',
    body: { prompt, top_k: 5 },
    timeoutMs,
  });

  if (result.ok && result.body && result.body.envelope) {
    writeStdout(result.body.envelope);
    writeStdout('\n\n');
  }
  writeStdout(prompt);
}

if (import.meta.main) {
  main().catch(() => {
    process.exit(0);
  });
}
