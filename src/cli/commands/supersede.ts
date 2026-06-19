// src/cli/commands/supersede.ts
//
// `captain-memo supersede` — inspect and reverse open supersede links.
//
// Subcommands:
//   list            Print all open supersede links (undone = 0), newest first.
//   undo <olderId>  Reverse a single supersede link by older observation ID.
//
// Operates on the DB file directly (separate SQLite connection). The worker
// re-queries on each request, so changes are picked up live.

import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { ObservationsStore } from '../../worker/observations-store.ts';

const HELP = `captain-memo supersede — inspect and reverse open supersede links

Usage:
  captain-memo supersede list
  captain-memo supersede undo <olderId>

Subcommands:
  list              Print all open supersede links, newest first.
  undo <olderId>    Reverse the supersede link for the given older observation ID.
`;

function dataDir(): string {
  return process.env.CAPTAIN_MEMO_DATA_DIR ?? join(homedir(), '.captain-memo');
}

export async function supersedeCommand(args: string[]): Promise<number> {
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP);
    return 0;
  }

  const obsPath = join(dataDir(), 'observations.db');
  if (!existsSync(obsPath)) {
    console.error(`captain-memo supersede: observations.db not found at ${obsPath}`);
    return 1;
  }

  if (sub === 'list') {
    const store = new ObservationsStore(obsPath, { readonly: true });
    try {
      const events = store.listSupersedeEvents(100);
      if (events.length === 0) {
        console.log('No open supersede links.');
        return 0;
      }
      for (const e of events) {
        console.log(`${e.older_id} → ${e.newer_id}  [${e.entity_key}]  ${e.older_version} ⇒ ${e.newer_version}`);
      }
      return 0;
    } finally {
      store.close();
    }
  }

  if (sub === 'undo') {
    const raw = args[1];
    if (!raw) {
      console.error('captain-memo supersede undo: missing <olderId>');
      console.error(HELP);
      return 2;
    }
    const olderId = Number(raw);
    if (!Number.isInteger(olderId) || olderId <= 0) {
      console.error(`captain-memo supersede undo: invalid id "${raw}"`);
      return 2;
    }
    const store = new ObservationsStore(obsPath);
    try {
      store.unlinkSupersede(olderId);
      console.log(`Supersede link for observation ${olderId} reversed.`);
      return 0;
    } finally {
      store.close();
    }
  }

  console.error(`Unknown supersede subcommand: ${sub}`);
  console.error(HELP);
  return 2;
}
