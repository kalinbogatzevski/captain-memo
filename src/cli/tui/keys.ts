// src/cli/tui/keys.ts
//
// Pure byte→key decoder for the `top` TUI. Raw-mode stdin delivers keystrokes
// as bytes (single chars, or multi-byte CSI escape sequences for arrows etc.).
// parseKey decodes the FIRST key in a buffer and returns the remainder, so a
// chunk carrying several keystrokes can be drained in a loop.

export type Key =
  | { type: 'char'; value: string }
  | { type: 'enter' }
  | { type: 'escape' }
  | { type: 'tab' }
  | { type: 'backspace' }
  | { type: 'ctrl-c' }
  | { type: 'up' } | { type: 'down' } | { type: 'left' } | { type: 'right' }
  | { type: 'pageup' } | { type: 'pagedown' }
  | { type: 'home' } | { type: 'end' }
  | { type: 'unknown'; raw: string };

interface ParseResult {
  key: Key;
  rest: string;
}

// CSI sequences keyed by the bytes following "\x1b[".
const CSI: Record<string, Key> = {
  'A': { type: 'up' },
  'B': { type: 'down' },
  'C': { type: 'right' },
  'D': { type: 'left' },
  'H': { type: 'home' },
  'F': { type: 'end' },
  '5~': { type: 'pageup' },
  '6~': { type: 'pagedown' },
  '1~': { type: 'home' },
  '4~': { type: 'end' },
};

export function parseKey(input: string): ParseResult {
  if (input.length === 0) return { key: { type: 'unknown', raw: '' }, rest: '' };

  const c = input[0]!;

  // Escape sequences (CSI). A lone ESC (no following '[') is the Escape key.
  if (c === '\x1b') {
    if (input[1] !== '[') return { key: { type: 'escape' }, rest: input.slice(1) };
    // Find the terminator: a letter, or '~' for numeric sequences.
    for (let i = 2; i < input.length; i++) {
      const ch = input[i]!;
      if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '~') {
        const seq = input.slice(2, i + 1);
        const key = CSI[seq] ?? ({ type: 'unknown', raw: '\x1b[' + seq } as Key);
        return { key, rest: input.slice(i + 1) };
      }
    }
    // Incomplete escape sequence — treat the whole thing as unknown.
    return { key: { type: 'unknown', raw: input }, rest: '' };
  }

  if (c === '\r' || c === '\n') return { key: { type: 'enter' }, rest: input.slice(1) };
  if (c === '\t') return { key: { type: 'tab' }, rest: input.slice(1) };
  if (c === '\x03') return { key: { type: 'ctrl-c' }, rest: input.slice(1) };
  if (c === '\x7f' || c === '\b') return { key: { type: 'backspace' }, rest: input.slice(1) };

  // Printable range.
  if (c >= ' ') return { key: { type: 'char', value: c }, rest: input.slice(1) };

  return { key: { type: 'unknown', raw: c }, rest: input.slice(1) };
}
