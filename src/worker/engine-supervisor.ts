// src/worker/engine-supervisor.ts — pure policy for engine-thread crashes. Respawn on
// crash, but cap respawns within a rolling window so a hard-broken engine (corrupt DB,
// bad config) degrades instead of fork-bombing — at which point the OS supervisor is the
// last resort.
export interface SupervisorState { crashes: number[]; }   // epoch ms of recent crashes
export interface SupervisorDecision { action: 'respawn' | 'give-up'; }

export function onEngineCrash(state: SupervisorState, now: number, maxInWindow = 5, windowMs = 60_000): SupervisorDecision {
  state.crashes = state.crashes.filter((t) => now - t < windowMs);
  state.crashes.push(now);
  return { action: state.crashes.length > maxInWindow ? 'give-up' : 'respawn' };
}
