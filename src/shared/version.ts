// Single source of truth for the app version.
//
// Everything that surfaces a version — the CLI banner, the worker's /stats
// response, the MCP server's serverInfo — imports VERSION from here, so the
// number can never diverge across the codebase. There is exactly one place to
// bump: package.json (which the guard test keeps in lockstep with plugin.json
// and marketplace.json). Never write a version literal anywhere else.
import pkg from '../../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
