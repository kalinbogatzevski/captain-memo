// TTY-aware ANSI helpers. When stdout is a pipe/file, codes drop out so log
// captures stay readable. Two env vars override the default detection:
//   NO_COLOR   — any value force-disables color (no-color.org standard).
//                Highest precedence — wins over FORCE_COLOR.
//   FORCE_COLOR— "1" (or any value other than "0") force-enables color even
//                when stdout is piped. Convention from npm/chalk. Use this
//                under `watch -c captain-memo stats` or `less -R` so colors
//                survive the intermediate pipe.

const RESET = '\x1b[0m';

export const isTTY = (): boolean => {
  if (process.env.NO_COLOR !== undefined) return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '0' && force !== '') return true;
  return process.stdout.isTTY === true;
};

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

const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/** Length of a string as the terminal would print it — strips SGR escape
 *  codes before counting. Required for aligning columns of color-wrapped
 *  text where .length would over-count by 8–12 chars per escape sequence. */
export function visibleWidth(s: string): number {
  return s.replace(ANSI_SGR_RE, '').length;
}

/** Pad a possibly-colored string with spaces on the RIGHT until its visible
 *  width equals `width`. Truncation is the caller's job — this helper only
 *  extends, never shortens. */
export function padVisibleEnd(s: string, width: number): string {
  const need = width - visibleWidth(s);
  return need > 0 ? s + ' '.repeat(need) : s;
}
