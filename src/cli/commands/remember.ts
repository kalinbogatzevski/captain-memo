import { readFileSync } from 'fs';
import { workerPost } from '../client.ts';

export interface RememberArgs {
  type: string;
  name?: string;
  description?: string;
  slug?: string;
  bodyInline?: string;  // from --body
  file?: string;        // from --file (path; contents read in readBody)
}

class RememberArgError extends Error {}

// Pull the value following a flag (`--flag value`). Fails loudly if the flag is
// present but its value is missing or looks like another flag — same contract as
// install.ts flagValue, so typos surface immediately.
function flagValue(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (v === undefined || v.startsWith('-')) {
    throw new RememberArgError(`${flag} requires a value (e.g. \`${flag} <value>\`).`);
  }
  return v;
}

// Pure flag parser — no I/O. Body resolution (file read / stdin) happens in
// readBody, so this is unit-testable in isolation (cf. parseInstallOptions).
export function parseRememberArgs(args: string[]): RememberArgs {
  let type: string | undefined;
  let name: string | undefined;
  let description: string | undefined;
  let slug: string | undefined;
  let bodyInline: string | undefined;
  let file: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--type':        type = flagValue(args, i, '--type'); i++; break;
      case '--name':        name = flagValue(args, i, '--name'); i++; break;
      case '--description': description = flagValue(args, i, '--description'); i++; break;
      case '--slug':        slug = flagValue(args, i, '--slug'); i++; break;
      case '--body':        bodyInline = flagValue(args, i, '--body'); i++; break;
      case '--file':        file = flagValue(args, i, '--file'); i++; break;
      default:
        throw new RememberArgError(`Unknown remember flag: ${arg}`);
    }
  }

  if (type === undefined) {
    throw new RememberArgError('--type is required (e.g. --type decision|feedback|reference|preference).');
  }
  if (bodyInline !== undefined && file !== undefined) {
    throw new RememberArgError('Pass only one body source: --body, --file, or stdin (not --body and --file together).');
  }

  return { type, name, description, slug, bodyInline, file };
}

export { RememberArgError };

// Resolve the body text: inline --body, else --file contents, else stdin.
// Exported so the source-precedence + file-read is unit-testable without a worker.
export async function readBody(parsed: RememberArgs): Promise<string> {
  if (parsed.bodyInline !== undefined) return parsed.bodyInline;
  if (parsed.file !== undefined) {
    try {
      return readFileSync(parsed.file, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RememberArgError(`Could not read --file ${parsed.file}: ${msg}`);
    }
  }
  // Fall back to stdin (piped body). new Response(...).text() drains Bun's stdin stream.
  const stdin = await new Response(Bun.stdin.stream()).text();
  return stdin;
}

interface RememberResult {
  ok: boolean;
  path?: string;
  action?: 'created' | 'updated';
  doc_id?: string;
  reason?: string;
}

export async function rememberCommand(args: string[]): Promise<number> {
  let parsed: RememberArgs;
  try {
    parsed = parseRememberArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  let body: string;
  try {
    body = await readBody(parsed);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (body.trim() === '') {
    console.error('Empty body. Provide content via --body <text>, --file <path>, or piped stdin.');
    return 2;
  }

  const payload: Record<string, unknown> = {
    body,
    type: parsed.type,
    cwd: process.cwd(),
  };
  if (parsed.name !== undefined) payload.name = parsed.name;
  if (parsed.description !== undefined) payload.description = parsed.description;
  if (parsed.slug !== undefined) payload.slug = parsed.slug;

  let result: RememberResult;
  try {
    result = await workerPost('/remember', payload) as RememberResult;
  } catch (err) {
    console.error(`remember failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (!result.ok) {
    console.error(`remember failed: ${result.reason ?? '(no reason given)'}`);
    return 1;
  }
  console.log(`Remembered (${result.action}):`);
  console.log(`  path:   ${result.path}`);
  console.log(`  doc_id: ${result.doc_id}`);
  return 0;
}
