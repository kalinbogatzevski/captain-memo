// src/hooks/update-apply.ts — the `UpdateApply` event: the DETACHED child the UserPromptSubmit hook spawns to run the opt-in
// self-update pass (CAPTAIN_MEMO_AUTO_UPDATE=1) outside the hook's 30 s Claude Code timeout (hooks/auto-update.ts startPromptUpdate).
// Not in plugin/hooks/hooks.json: nothing but that spawn names it. It is spawned with stdio ignored, so it never reads stdin.
import { logHookError } from './shared.ts';

/** Nothing in the pass was found unbounded (every git call has a deadline, `bun install` 300 s, systemctl 10 s, each boot wait 30 s,
 *  the live-session ask 1.5 s: the caps of an apply add up to 367.5 s, those of a rollback to about 350 s more), but nothing outside
 *  this process reaps a detached child, as Claude Code's 30 s cut did for the in-line one. 30 min, over twice the sum of the
 *  caps, is the backstop that guarantees the child ends; it should never fire. It runs for the whole life of the process, not
 *  just the pass (a handle that outlives the pass is cut too) and is unref'd, so it never keeps the process up. It cannot
 *  preempt a blocking spawnSync: each of those has the caps above. */
export const UPDATE_APPLY_BACKSTOP_MS = 30 * 60_000;

export interface UpdateApplyDeps {
  pass?: typeof import('./auto-update.ts').runAutoUpdatePass;
  backstopMs?: number;
  exit?: (code: number) => void;
}

export async function main(d: UpdateApplyDeps = {}): Promise<void> {
  // The same opt-in gate as the spawner, so running the event by hand on a captain that did not opt in does nothing.
  if (process.env.CAPTAIN_MEMO_AUTO_UPDATE !== '1') return;
  const backstopMs = d.backstopMs ?? UPDATE_APPLY_BACKSTOP_MS;
  const backstop = setTimeout(() => {
    logHookError('UpdateApply', new Error(`auto-update: still running after ${Math.round(backstopMs / 1000)} s, exiting`));
    (d.exit ?? process.exit)(0);
  }, backstopMs);
  backstop.unref();
  try {
    const { applyPromptUpdate } = await import('./auto-update.ts');
    await applyPromptUpdate('UpdateApply', d.pass);
  } catch (err) {
    logHookError('UpdateApply', err);
  }
}
