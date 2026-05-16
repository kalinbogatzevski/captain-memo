import { test, expect, afterEach } from 'bun:test';
import { cyan } from '../../src/shared/ansi.ts';

afterEach(() => { delete process.env.NO_COLOR; });

test('ansi — NO_COLOR strips colour even when stdout is a TTY', () => {
  const originalIsTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    process.env.NO_COLOR = '1';
    expect(cyan('hello')).toBe('hello');           // no escape codes
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  }
});

test('ansi — empty NO_COLOR value still disables colour (presence is the signal)', () => {
  const originalIsTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    process.env.NO_COLOR = '';
    expect(cyan('hello')).toBe('hello');
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  }
});
