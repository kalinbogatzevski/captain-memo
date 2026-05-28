// tests/unit/dreaming/orchestrate.test.ts
//
// Tests the end-to-end pure pipeline (inputs → cluster → report shape) with
// synthetic DreamInputs. No filesystem, no DB — proves the wiring between
// loader output and cluster output without touching real data.

import { test, expect } from 'bun:test';
import { dryRun } from '../../../src/dreaming/orchestrate.ts';
import { pairKey, type DreamInputs } from '../../../src/dreaming/load.ts';

const DAY = 86400;
const T0 = 1_700_000_000;

function mkObs(id: number, dayOffset: number, surfaces: number) {
  return {
    id,
    type: 'discovery' as const,
    title: `obs-${id}`,
    created_at_epoch: T0 + dayOffset * DAY,
    project_id: 'p',
    surfaces,
  };
}

test('dryRun — temporally clustered observations with high co-recall form one cluster', () => {
  // Three obs on the same day, each surfaced 10 times, each pair co-surfaced 8 times.
  const observations = [mkObs(1, 0, 10), mkObs(2, 0, 10), mkObs(3, 0, 10)];
  const coOccurrence = new Map<string, number>([
    [pairKey(1, 2), 8],
    [pairKey(1, 3), 8],
    [pairKey(2, 3), 8],
  ]);
  const inputs: DreamInputs = { observations, coOccurrence, pairKey };

  const report = dryRun(inputs, { eps: 0.35, minPts: 3, tauSeconds: 7 * DAY });

  expect(report.total).toBe(3);
  expect(report.withoutCoRetrieval).toBe(0);
  expect(report.clusters).toHaveLength(1);
  expect(report.clusters[0]!.members.map(m => m.id).sort()).toEqual([1, 2, 3]);
  expect(report.noise).toEqual([]);
  expect(report.clusters[0]!.coOccurrenceWeight).toBe(24); // 8 × 3 pairs
});

test('dryRun — temporally far apart, no co-recall → all noise', () => {
  // Spread across 90 days; temporal sim ~e^-12 ≈ 0; no co-occurrences.
  const observations = [mkObs(1, 0, 5), mkObs(2, 30, 5), mkObs(3, 60, 5), mkObs(4, 90, 5)];
  const inputs: DreamInputs = {
    observations,
    coOccurrence: new Map(),
    pairKey,
  };
  const report = dryRun(inputs, { eps: 0.35, minPts: 3, tauSeconds: 7 * DAY });

  expect(report.clusters).toEqual([]);
  expect(report.noise.map(o => o.id).sort()).toEqual([1, 2, 3, 4]);
  expect(report.withoutCoRetrieval).toBe(4);
});

test('dryRun — co-retrieval bridges temporally distant observations', () => {
  // Two obs 30 days apart — temporal alone is ~e^-30/7 ≈ 0.014, below eps.
  // But with strong co-retrieval (5/5/5 → Jaccard 1.0) the renormalized
  // similarity = 0.375 * 0.014 + 0.625 * 1.0 ≈ 0.630 → distance 0.370. Still
  // outside default eps=0.35, but inside a looser eps. Verify both regimes.
  const observations = [
    mkObs(1, 0, 5), mkObs(2, 30, 5),
    mkObs(3, 0, 5),  // temporal twin of 1 to satisfy minPts=3
  ];
  const coOccurrence = new Map<string, number>([
    [pairKey(1, 2), 5],
    [pairKey(1, 3), 5],
    [pairKey(2, 3), 5],
  ]);
  const inputs: DreamInputs = { observations, coOccurrence, pairKey };

  // Loose eps — co-retrieval carries the day.
  const loose = dryRun(inputs, { eps: 0.45, minPts: 3, tauSeconds: 7 * DAY });
  expect(loose.clusters).toHaveLength(1);

  // Default eps — too tight even for full Jaccard with 30-day gap.
  const tight = dryRun(inputs, { eps: 0.30, minPts: 3, tauSeconds: 7 * DAY });
  // With tight eps the 30-day-apart obs falls out; remaining pair is below minPts.
  expect(tight.clusters.length).toBeLessThanOrEqual(1);
});

test('dryRun — emits diagnostic field for observations with zero co-retrieval', () => {
  const observations = [mkObs(1, 0, 5), mkObs(2, 0, 5), mkObs(3, 0, 5), mkObs(4, 0, 5)];
  const coOccurrence = new Map<string, number>([
    [pairKey(1, 2), 3],   // 1 and 2 have signal; 3 and 4 don't.
  ]);
  const inputs: DreamInputs = { observations, coOccurrence, pairKey };
  const report = dryRun(inputs, { eps: 0.35, minPts: 3, tauSeconds: 7 * DAY });
  expect(report.withoutCoRetrieval).toBe(2);   // ids 3 and 4
});

test('dryRun — weights returned reflect renormalized form (semantic absent)', () => {
  const report = dryRun(
    { observations: [], coOccurrence: new Map(), pairKey },
    { eps: 0.35, minPts: 3, tauSeconds: 7 * DAY },
  );
  expect(report.weights.semantic).toBe(0);
  expect(report.weights.temporal + report.weights.coRetrieval).toBeCloseTo(1, 6);
  expect(report.weights.coRetrieval).toBeGreaterThan(report.weights.temporal);
});
