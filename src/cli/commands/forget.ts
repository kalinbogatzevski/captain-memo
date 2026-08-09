// `captain-memo forget <doc_id|path>` — the other half of `remember`.
//
// Deleting the .md by hand does NOT unpublish a memory: the document, its chunks and its vectors stay
// in the index and keep answering searches, so the entry lives on with no file behind it. This is the
// supported way to remove one, and it takes the index down first and the file second.
//
// DESTRUCTIVE and not undoable — there is no tombstone and no trash. So it CONFIRMS by default and
// prints exactly what it is about to remove; --yes is for scripts that already know.

import { createInterface } from 'readline';
import { workerPost } from '../client.ts';

export interface ForgetArgs {
  target: string;          // doc_id (`memory:reference_foo`) or an absolute path
  byPath: boolean;         // target is a path, not a doc_id
  dryRun: boolean;
  yes: boolean;
}

class ForgetArgError extends Error {}

interface ForgetResult {
  ok?: boolean;
  dry_run?: boolean;
  path?: string;
  chunks?: number;
  file_exists?: boolean;
  file_removed?: boolean;
  warning?: string;
}

/** Pure flag parser — no I/O, so it unit-tests in isolation (cf. parseRememberArgs). */
export function parseForgetArgs(args: string[]): ForgetArgs {
  let target: string | undefined;
  let byPath = false;
  let dryRun = false;
  let yes = false;

  for (const arg of args) {
    switch (arg) {
      case '--dry-run': dryRun = true; break;
      case '--yes': case '-y': yes = true; break;
      case '--path': byPath = true; break;
      default:
        if (arg.startsWith('-')) throw new ForgetArgError(`unknown flag: ${arg}`);
        if (target !== undefined) {
          throw new ForgetArgError(`only one target at a time (got "${target}" and "${arg}")`);
        }
        target = arg;
    }
  }

  if (target === undefined) throw new ForgetArgError('a doc_id or path is required');
  // An absolute path passed without --path is a slip worth catching: it would be looked up as a
  // doc_id, miss, and report "not found" about a file that plainly exists.
  if (!byPath && (target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target))) byPath = true;
  return { target, byPath, dryRun, yes };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return answer.trim().toLowerCase() === 'y';
  } finally { rl.close(); }
}

export async function forgetCommand(args: string[]): Promise<number> {
  let parsed: ForgetArgs;
  try {
    parsed = parseForgetArgs(args);
  } catch (err) {
    console.error(`forget: ${err instanceof Error ? err.message : String(err)}`);
    console.error('usage: captain-memo forget <doc_id|path> [--path] [--dry-run] [--yes]');
    return 1;
  }

  const payload = parsed.byPath ? { path: parsed.target } : { doc_id: parsed.target };

  // Always look before deleting — the preview doubles as the existence check, so a typo reports
  // "not found" without anything having happened.
  let preview: ForgetResult;
  try {
    preview = await workerPost('/forget', { ...payload, dry_run: true }) as ForgetResult;
  } catch (err) {
    console.error(`forget failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  console.log(`  path:   ${preview.path}`);
  console.log(`  chunks: ${preview.chunks}`);
  console.log(`  file:   ${preview.file_exists ? 'present (will be deleted)' : 'already gone'}`);

  if (parsed.dryRun) {
    console.log('Dry run — nothing removed.');
    return 0;
  }

  if (!parsed.yes && !await confirm('Delete this memory permanently? [y/N] ')) {
    console.log('Aborted — nothing removed.');
    return 0;
  }

  let result: ForgetResult;
  try {
    result = await workerPost('/forget', payload) as ForgetResult;
  } catch (err) {
    console.error(`forget failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (!result.ok) {
    console.error('forget failed: the worker did not confirm the delete');
    return 1;
  }
  console.log(`Forgotten: ${result.path} (${result.chunks} chunk(s))`);
  if (result.warning) console.warn(`  warning: ${result.warning}`);
  return 0;
}
