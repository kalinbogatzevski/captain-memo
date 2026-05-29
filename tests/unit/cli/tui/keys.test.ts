import { test, expect } from 'bun:test';
import { parseKey } from '../../../../src/cli/tui/keys.ts';

test('parseKey — printable char, leaving the rest of the buffer', () => {
  expect(parseKey('q')).toEqual({ key: { type: 'char', value: 'q' }, rest: '' });
  expect(parseKey('jk')).toEqual({ key: { type: 'char', value: 'j' }, rest: 'k' });
});

test('parseKey — control keys', () => {
  expect(parseKey('\r').key).toEqual({ type: 'enter' });
  expect(parseKey('\n').key).toEqual({ type: 'enter' });
  expect(parseKey('\t').key).toEqual({ type: 'tab' });
  expect(parseKey('\x03').key).toEqual({ type: 'ctrl-c' });
  expect(parseKey('\x7f').key).toEqual({ type: 'backspace' });
});

test('parseKey — a lone ESC is escape', () => {
  expect(parseKey('\x1b').key).toEqual({ type: 'escape' });
});

test('parseKey — arrow escape sequences', () => {
  expect(parseKey('\x1b[A').key).toEqual({ type: 'up' });
  expect(parseKey('\x1b[B').key).toEqual({ type: 'down' });
  expect(parseKey('\x1b[C').key).toEqual({ type: 'right' });
  expect(parseKey('\x1b[D').key).toEqual({ type: 'left' });
});

test('parseKey — page and home/end sequences', () => {
  expect(parseKey('\x1b[5~').key).toEqual({ type: 'pageup' });
  expect(parseKey('\x1b[6~').key).toEqual({ type: 'pagedown' });
  expect(parseKey('\x1b[H').key).toEqual({ type: 'home' });
  expect(parseKey('\x1b[F').key).toEqual({ type: 'end' });
});

test('parseKey — consumes only the first key, returns rest for the next parse', () => {
  const first = parseKey('\x1b[Bx');
  expect(first.key).toEqual({ type: 'down' });
  expect(first.rest).toBe('x');
  const second = parseKey(first.rest);
  expect(second.key).toEqual({ type: 'char', value: 'x' });
});

test('parseKey — empty buffer yields unknown', () => {
  expect(parseKey('').key.type).toBe('unknown');
});
