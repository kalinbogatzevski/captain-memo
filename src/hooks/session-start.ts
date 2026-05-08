import { readStdinJson, workerFetch, logHookError } from './shared.ts';
import { DEFAULT_HOOK_TIMEOUT_MS, ENV_HOOK_TIMEOUT_MS } from '../shared/paths.ts';

interface SessionStartPayload {
  session_id?: string;
  cwd?: string;
  source?: 'startup' | 'resume' | 'compact' | string;
}

async function main(): Promise<void> {
  try { await readStdinJson<SessionStartPayload>(); } catch { /* ignore */ }
  const timeoutMs = Number(process.env[ENV_HOOK_TIMEOUT_MS] ?? DEFAULT_HOOK_TIMEOUT_MS);

  await workerFetch('/health', { method: 'GET', timeoutMs });

  // SessionStart is a no-output warmup. Anything we'd inject here would land
  // in the system prompt — leave that to UserPromptSubmit.
}

if (import.meta.main) {
  main().catch((err) => {
    logHookError('SessionStart', err);
    process.exit(0);
  });
}
