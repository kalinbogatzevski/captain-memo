import { test, expect } from 'bun:test';
import { summarize } from '../../src/hooks/shared.ts';

// A made-up token placed so the 1500 / 2000 cut lands inside it: no head of it may survive.
const TOKEN = 'glpat-AbCdEfGhIjKlMnOpQrSt12';

test('summarize redacts before it cuts: a token straddling the cut leaves no head', () => {
  for (const max of [1500, 2000]) {
    for (let off = max - 30; off <= max + 10; off++) {
      const out = summarize('x'.repeat(off) + ' ' + TOKEN + ' tail'.repeat(400), max);
      expect(out).not.toContain('glpat-');
      expect([...out].length).toBeLessThanOrEqual(max);
    }
  }
});
