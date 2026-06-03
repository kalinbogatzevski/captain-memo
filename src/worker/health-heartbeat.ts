// src/worker/health-heartbeat.ts — pure verdict for the main thread's /health, derived
// from the engine's last heartbeat. Non-blocking AND honest: a fresh beat means the
// engine's loop is turning (healthy); a stale beat means it's wedged on its last op.
export interface HeartbeatState { lastBeatMs: number; busyOp: string | null; }
export interface HealthVerdict { healthy: boolean; degraded?: string; }

export function healthFromHeartbeat(state: HeartbeatState, now: number, freshMs = 5000): HealthVerdict {
  const age = now - state.lastBeatMs;
  if (age < freshMs) return { healthy: true };
  const where = state.busyOp ? `on ${state.busyOp}` : 'idle';
  return { healthy: false, degraded: `engine unresponsive ${age}ms (${where})` };
}
