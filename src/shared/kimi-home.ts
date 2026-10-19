// kimi 2.x ("kimi-code") home. Shared by cross-ai.ts (connect) and skill-refresh.ts / ai-skill-sources.ts (the hook bundle
// and the worker), so it imports only path + os.
import { homedir } from 'os';
import { join } from 'path';

/** kimi 2.x keeps its config.toml, mcp.json, skills/ and sessions/ in $KIMI_CODE_HOME, else <home>/.kimi-code (kimi-code
 *  2.2.0, resolveKimiHome in agent-core-v2 bootstrap.ts). The 1.x home (~/.kimi, $KIMI_HOME) is another directory that only
 *  1.x reads. kimi itself takes an EMPTY KIMI_CODE_HOME as the home (`??`, so cwd-relative paths); here an empty value counts
 *  as unset, like codexHomeDir, so a stray `KIMI_CODE_HOME=` never points connect at the working directory. `env` is
 *  injectable so a test never reads the developer's real one. */
export function kimiCodeHomeDir(home: string = homedir(), env: Record<string, string | undefined> = process.env): string {
  return env.KIMI_CODE_HOME || join(home, '.kimi-code');
}
