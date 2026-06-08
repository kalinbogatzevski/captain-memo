import { DEFAULT_WORKER_PORT } from '../shared/paths.ts';

const BASE = `http://localhost:${process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT}`;

export async function workerGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function workerPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Like workerGet but returns null instead of throwing when the endpoint is
 *  absent/unreachable. Lets optional panels degrade silently. */
export async function workerGetOptional(path: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function workerHealthy(): Promise<boolean> {
  try {
    const result = await workerGet('/health') as { healthy: boolean };
    return result.healthy === true;
  } catch {
    return false;
  }
}
