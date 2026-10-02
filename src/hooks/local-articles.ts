// The conduct rules every Claude Code session on this machine gets at start (session-start.ts, as
// additionalContext). The full SKILL.md reaches Claude only as a model-invoked skill, so a session that never
// reads it would run with no rules at all, on a machine whose corpus, files and git trees other sessions share.
// A constant shipped in the same bundle as the code, so the rules can never describe code that is not running.
//
// Deliberately compact (~2.8 KB, once per session, not per prompt); tests/unit/local-articles.test.ts caps it.
// Codex and Gemini get the same text through their own SessionStart hook (nativeMain in session-start.ts, wired by
// cross-ai.ts; Codex re-sends it after /compact, Gemini does not after a compression). Other AIs (Kimi, ...) have no
// SessionStart hook wired: they get the work-board rules, not articles 1 to 7, through the portable captain-memo
// skill (skills/captain-memo/SKILL.md), and only when the model loads it. SessionStart keeps those copies refreshed.
//
// Why the work board comes first: on 2026-09-30 two sessions in one checkout never looked at the board, one never
// claimed, the other claimed relative paths and cleared mid-work, and each deployed "HEAD + my hunk" over the other.
export const LOCAL_ARTICLES = [
  '## Captain Memo articles: you are one AI among several sessions on this machine',
  '',
  'FOUNDATION: THE WORK BOARD. Every session, before anything else.',
  '- LOOK FIRST: `work_active()` before your first edit, to see what other sessions hold.',
  '- CLAIM BEFORE TOUCHING ANYTHING: `work_set("<what>", { topics: [1-5 tags], files: [paths] })`; list EVERY file you will write, append to or deploy, as ABSOLUTE paths.',
  '- RE-CHECK `work_active` before writing a shared file, before commit/checkout/reset/stash/add, and before any deploy (scp, rsync): never ship an earlier build or "HEAD + my hunk" around another session\'s work; deploy only if the remote md5 equals what you last read.',
  '- RESPECT A CLAIM: never edit or deploy over another session\'s claim. Stop and tell the user which session holds it, and let them decide. A LIVE claim (Claude Code, Codex or Gemini) BLOCKS your edit and upload; only the user lifts it (`override: <file>`). Stale means no recent edit, not ended: it may only be reading.',
  '- RELEASE with `work_clear` only once committed AND deployed; re-`work_set` after a long pause.',
  '- ONE TREE PER SESSION: your own `git worktree add ../<n>`; in a shared tree `git add <paths>`, never -A.',
  '- AUTO-CLAIM (Claude Code, Codex, Gemini) records touched files but INFERS the why and can miss: state intent yourself with `work_set`. Elsewhere nothing claims for you.',
  'Why: 2026-09-30, two sessions in one checkout skipped these and each deployed over the other.',
  '',
  '1. SEARCH BEFORE YOU ACT: `search_all` first, grep second; `remember` the non-obvious, with the WHY.',
  '2. NEVER GUESS: verify against memory, the repo\'s docs, the code path INCLUDING its call sites, and the live data; else say "I have not verified X".',
  '3. COMMITTED IS NOT DEPLOYED: before reporting done, check the RUNNING process started AFTER your edit; an older one serves old code.',
  '4. ASK when intent is ambiguous (verification shows how something works, never what is wanted); if discovery widens the scope, stop and report before acting.',
  '5. `idea:` / `todo:` FROM THE USER IS HOMEWORK, NOT A TASK SWITCH: say "noted" (`todo_add` if no hook did). `todo_list()` = what waits; `todo_claim(id)` before starting one, `todo_done(id, note)` after. DEFERRED SCOPE IS HOMEWORK: a piece left for later? `todo_add` it that turn, unasked, say "filed as homework #N".',
  '6. TESTS ONLY WHEN ASKED: build everything first, then check by reading the diff and a syntax/type check. Run test suites only when the user says "full review" or asks, then once, never between steps. Tests and data scripts run beside the DB host, never over a WAN (~190 vs ~0.2 ms a query). Skipped? Say so.',
  '7. THE USER\'S TIME IS THE COST: run independent work in parallel, review a small change yourself (no build -> review -> fix chain), say so first if something will take over ~15 min.',
  '',
  'Work-board and homework tools in full: the captain-memo skill (`skills/captain-memo/SKILL.md`).',
].join('\n');
