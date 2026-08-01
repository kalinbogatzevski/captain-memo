// src/cli/commands/theme.ts
//
// `captain-memo theme` — inspect and reverse machine-written themes.
//
// Themes are the one part of the corpus the Captain WROTE rather than observed: a cross-session
// cluster of restatements consolidated into one durable fact, with the originals archived
// beneath it. Generated text you cannot read back or reverse would be unacceptable, so this
// command exists alongside the pass rather than after it.
//
// Subcommands:
//   list            Live themes, newest first, with the observations each stands for.
//   show <id>       One theme in full, plus every member it archived.
//   undo <id>       Restore the members and retire the theme.
//
// Operates on the DB file directly (separate SQLite connection). The worker re-queries on each
// request, so changes are picked up live.

import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { ObservationsStore } from '../../worker/observations-store.ts';
import { cyan, cyanBold, dim, gold, green, bold } from '../../shared/ansi.ts';

const HELP = `captain-memo theme — inspect and reverse machine-written themes

Usage:
  captain-memo theme list [--json]
  captain-memo theme show <id>
  captain-memo theme undo <id>

Subcommands:
  list              Live themes, newest first, with the observations each stands for.
  show <id>         One theme in full, plus every member archived beneath it.
  undo <id>         Restore every member and retire the theme.

Notes:
  - A theme is GENERATED text: the Captain wrote it from several observations that said the
    same durable thing across different sessions. Everything else in the corpus was observed.
  - Undo is complete and idempotent: members come back unarchived, the theme steps aside.
    Nothing is ever hard-deleted.
`;

function dataDir(): string {
  return process.env.CAPTAIN_MEMO_DATA_DIR ?? join(homedir(), '.captain-memo');
}

const day = (epoch: number): string => new Date(epoch * 1000).toISOString().slice(0, 10);

export async function themeCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === '-h' || sub === '--help') { console.log(HELP); return sub ? 0 : 2; }

  const obsPath = join(dataDir(), 'observations.db');
  if (!existsSync(obsPath)) {
    console.error(`captain-memo theme: observations.db not found at ${obsPath}`);
    return 1;
  }
  const store = new ObservationsStore(obsPath);
  try {
    if (sub === 'list') return runList(store, args.includes('--json'));
    if (sub === 'show') return runShow(store, Number(args[1]));
    if (sub === 'undo') return runUndo(store, Number(args[1]));
    console.error(`Unknown subcommand: ${sub}`);
    console.error(HELP);
    return 2;
  } finally {
    store.close();
  }
}

function runList(store: ObservationsStore, json: boolean): number {
  const themes = store.listThemes(200);
  if (json) { console.log(JSON.stringify({ themes }, null, 2)); return 0; }
  if (themes.length === 0) {
    console.log(dim('No themes yet. They are written during idle passes, once the same fact has'));
    console.log(dim('been learned in several separate sessions.'));
    return 0;
  }
  console.log(`${cyanBold('captain-memo themes')} ${dim(`· ${themes.length} live`)}`);
  console.log('');
  for (const t of themes) {
    console.log(`  ${gold(String(t.id).padStart(7))}  ${bold(t.title)}`);
    console.log(`  ${dim(' '.repeat(7))}  ${dim(`${day(t.created_at_epoch)} · stands for ${t.member_ids.length} observation(s)`)}`);
  }
  console.log('');
  console.log(dim('  captain-memo theme show <id>   to read one in full'));
  console.log(dim('  captain-memo theme undo <id>   to restore its members'));
  return 0;
}

function runShow(store: ObservationsStore, id: number): number {
  if (!Number.isFinite(id)) { console.error('theme show needs a numeric id'); return 2; }
  const theme = store.findById(id);
  if (!theme || !theme.theme_member_ids) {
    console.error(`No theme with id ${id}. (\`captain-memo theme list\` shows the live ones.)`);
    return 1;
  }
  console.log(`${cyanBold(theme.title)}`);
  console.log(dim(`  id ${theme.id} · ${day(theme.created_at_epoch)} · ${theme.archived ? 'RETIRED' : 'live'}`));
  if (theme.narrative) { console.log(''); console.log(`  ${theme.narrative}`); }
  if (theme.facts.length > 0) {
    console.log('');
    for (const f of theme.facts) console.log(`  ${cyan('·')} ${f}`);
  }
  console.log('');
  console.log(dim(`  Written from ${theme.theme_member_ids.length} observation(s):`));
  for (const mid of theme.theme_member_ids) {
    const m = store.findById(mid);
    if (!m) { console.log(dim(`    ${mid} (gone)`)); continue; }
    console.log(`    ${dim(day(m.created_at_epoch))}  ${m.archived ? dim(m.title) : green(m.title)}`);
  }
  return 0;
}

function runUndo(store: ObservationsStore, id: number): number {
  if (!Number.isFinite(id)) { console.error('theme undo needs a numeric id'); return 2; }
  const restored = store.unmakeTheme(id);
  if (restored === 0) {
    console.log(dim(`Nothing to undo for id ${id} — not a live theme.`));
    return 0;
  }
  console.log(`${green('✓')} Restored ${cyanBold(String(restored))} observation(s); theme ${id} retired.`);
  return 0;
}
