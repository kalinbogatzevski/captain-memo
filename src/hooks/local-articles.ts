// The conduct rules every Claude Code session on this machine gets at start (session-start.ts, as
// additionalContext). The full SKILL.md reaches Claude only as a model-invoked skill, so a session that never
// reads it would run with no rules at all, on a machine whose corpus, files and git trees other sessions share.
// A constant shipped in the same bundle as the code, so the rules can never describe code that is not running.
//
// Deliberately compact (~2.8 KB, once per session, not per prompt); tests/unit/local-articles.test.ts caps it.
// Other AIs (Codex, Gemini, Kimi, ...) have no SessionStart hook wired (cross-ai.ts installs only their prompt,
// tool and stop hooks): they get the work-board rules, not articles 1 to 7, through the portable captain-memo
// skill (skills/captain-memo/SKILL.md), and only when the model loads it. SessionStart keeps those copies refreshed.
//
// Why the work board comes first: on 2026-09-30 two sessions in one checkout never looked at the board, one never
// claimed, the other claimed relative paths and cleared mid-work, and each deployed "HEAD + my hunk" over the other.
export const LOCAL_ARTICLES = [
  '## Captain Memo articles: you are one AI among several sessions on this machine',
  '',
  'FOUNDATION: THE WORK BOARD. Every session, every project, before anything else.',
  '- LOOK FIRST: `work_active()` before your first edit, to see what other sessions hold.',
  '- CLAIM BEFORE TOUCHING ANYTHING: `work_set("<what>", { topics: [1-5 tags], files: [paths] })`. List',
  '  EVERY file you will write, append to or deploy, as ABSOLUTE paths.',
  '- RE-CHECK `work_active` before writing a shared file, before commit/checkout/reset/stash/add, and before',
  '  any deploy (scp, rsync). Never ship a copy built earlier, or "HEAD + my hunk" around another session\'s',
  '  work. Deploy only if the remote md5 equals what you last read.',
  '- RESPECT A CLAIM: never edit or deploy over another session\'s claim. Stop and tell the user which',
  '  session holds it, and let them decide. Stale means no recent edit, not ended: it may only be reading.',
  '- RELEASE with `work_clear` only once committed AND deployed; re-`work_set` after a long pause.',
  '- ONE TREE PER SESSION: your own `git worktree add ../<n>`. Shared tree? `git add <paths>`, never -A.',
  '- AUTO-CLAIM (Claude Code only) records the files you touch but INFERS the why, and can miss.',
  '  State intent yourself with `work_set`. On every other AI nothing claims for you.',
  'Why: on 2026-09-30 two sessions in one checkout skipped these steps and each deployed over the other.',
  '',
  '1. SEARCH BEFORE YOU ACT. `search_all` first, grep second. `remember` what is non-obvious, with the WHY.',
  '2. NEVER GUESS. Verify against memory, the repo\'s docs, the code path INCLUDING its call sites, and the',
  '   live data. If you have not, say "I have not verified X".',
  '3. COMMITTED IS NOT DEPLOYED. Before reporting done, check the RUNNING process started AFTER your edit.',
  '   A service that predates your change is serving the old code.',
  '4. ASK when intent is ambiguous; verification tells you how something works, never what is wanted.',
  '   If mid-task discovery widens the scope, stop and report it before acting.',
  '5. `idea:` / `todo:` FROM THE USER IS HOMEWORK, NOT A TASK SWITCH: say "noted" (`todo_add` if no hook did).',
  '   `todo_list()` = what waits; `todo_claim(id)` before starting one, `todo_done(id, note)` after.',
  '   DEFERRED SCOPE IS HOMEWORK: agreed to leave a piece for later? `todo_add` it in that turn, unasked,',
  '   and say "filed as homework #N".',
  '6. RUN WORK NEXT TO ITS DATA: tests and data scripts run on (or beside) the DB host, never over a WAN',
  '   (~190 vs ~0.2 ms a query). Iterate on the tests a change touches; one full run at the end.',
  '7. THE USER\'S TIME IS THE COST. Independent work runs in parallel. Review a small change yourself, no',
  '   build -> review -> fix chain. Over ~15 min? Say so first.',
  '',
  'Work-board and homework tools in full: the captain-memo skill (`skills/captain-memo/SKILL.md`).',
].join('\n');
