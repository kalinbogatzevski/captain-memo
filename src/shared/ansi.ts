// TTY-aware ANSI helpers. When stdout is a pipe/file, codes drop out so log
// captures stay readable.

const RESET = '\x1b[0m';

export const isTTY = (): boolean => process.stdout.isTTY === true;

export function wrap(code: string, s: string): string {
  return isTTY() && code ? `\x1b[${code}m${s}${RESET}` : s;
}

export const bold     = (s: string): string => wrap('1', s);
export const dim      = (s: string): string => wrap('2', s);
export const cyan     = (s: string): string => wrap('36', s);
export const gold     = (s: string): string => wrap('33', s);
export const green    = (s: string): string => wrap('32', s);
export const yellow   = (s: string): string => wrap('33', s);
export const red      = (s: string): string => wrap('31', s);
export const boldRed  = (s: string): string => wrap('31;1', s);
export const cyanBold = (s: string): string => wrap('36;1', s);
export const cyanDim  = (s: string): string => wrap('36;2', s);
export const goldBold = (s: string): string => wrap('33;1', s);
