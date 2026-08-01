import { test, expect, describe } from 'bun:test';
import { DEFAULT_TIDE_CONFIG, nextStability } from '../../../src/worker/tide.ts';

// stabilityCapDays is named "cap" and documented as "Hot rows plateau", but it only ever appeared
// as a saturation term: fS = cap / (cap + S). That SLOWS growth without bounding it, so S grew
// without limit. On the reference corpus one row reached 11,730 days — 32 years of stability on
// an observation 45 days old, from 81 searches. A row like that can never ebb, which makes it
// permanently anchored without anyone anchoring it, and defeats tiering for exactly the rows most
// likely to be one intense week's trivia.
describe('nextStability', () => {
  const cfg = DEFAULT_TIDE_CONFIG;

  test('never exceeds stabilityCapDays, however many recalls', () => {
    let s: number | null = null;
    for (let i = 0; i < 500; i++) s = nextStability(s, 'search', cfg);
    expect(s).toBeLessThanOrEqual(cfg.stabilityCapDays);
  });

  test('the cap holds for the strongest source too', () => {
    let s: number | null = null;
    for (let i = 0; i < 500; i++) s = nextStability(s, 'drill', cfg);
    expect(s).toBeLessThanOrEqual(cfg.stabilityCapDays);
  });

  // The clamp must not flatten the curve it bounds: early recalls should still grow stability
  // meaningfully, or a hot row loses its resistance to forgetting entirely.
  test('still grows, and still rewards a drill more than an auto-inject', () => {
    const s0 = nextStability(null, 'auto', cfg);
    const s1 = nextStability(null, 'drill', cfg);
    expect(s0).toBeGreaterThan(cfg.s0.observation);
    expect(s1).toBeGreaterThan(s0);
  });

  test('an already-over-cap value from before the clamp is brought back into range', () => {
    expect(nextStability(11_730, 'search', cfg)).toBeLessThanOrEqual(cfg.stabilityCapDays);
  });

  test('a custom cap is honoured', () => {
    const tight = { ...cfg, stabilityCapDays: 30 };
    let s: number | null = null;
    for (let i = 0; i < 200; i++) s = nextStability(s, 'drill', tight);
    expect(s).toBeLessThanOrEqual(30);
  });
});
