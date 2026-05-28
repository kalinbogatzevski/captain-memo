// tests/unit/dreaming/cluster.test.ts
//
// Pure DBSCAN tests against synthetic point sets where the expected clusters
// can be reasoned about by hand. Distance functions used here are 1D
// arithmetic so the geometry is unambiguous — these tests cover the
// algorithm's behavior, NOT the spec's signal weighting (that's distance.ts).

import { test, expect } from 'bun:test';
import { cluster } from '../../../src/dreaming/cluster.ts';

/** 1D Euclidean distance keyed on a position lookup. */
function dist1D(positions: Record<number, number>): (a: number, b: number) => number {
  return (a, b) => Math.abs((positions[a] ?? 0) - (positions[b] ?? 0));
}

test('cluster — empty input returns empty clusters and noise', () => {
  const out = cluster([], () => 0, { eps: 0.5, minPts: 3 });
  expect(out.clusters).toEqual([]);
  expect(out.noise).toEqual([]);
});

test('cluster — single point with minPts > 1 becomes noise', () => {
  const out = cluster([1], (_a, _b) => 0, { eps: 0.5, minPts: 3 });
  expect(out.clusters).toEqual([]);
  expect(out.noise).toEqual([1]);
});

test('cluster — three colocated points form one cluster (minPts boundary)', () => {
  // Positions: 0, 0.1, 0.2 — eps 0.3 covers all pairs; minPts=3 satisfied.
  const positions = { 1: 0, 2: 0.1, 3: 0.2 };
  const out = cluster([1, 2, 3], dist1D(positions), { eps: 0.3, minPts: 3 });
  expect(out.clusters).toHaveLength(1);
  expect(out.clusters[0]!.sort()).toEqual([1, 2, 3]);
  expect(out.noise).toEqual([]);
});

test('cluster — two well-separated dense groups produce two clusters', () => {
  // Group A around 0; group B around 10. Eps 0.5 keeps them apart.
  const positions = {
    1: 0, 2: 0.1, 3: 0.2,        // A
    4: 10, 5: 10.1, 6: 10.2,     // B
  };
  const out = cluster([1, 2, 3, 4, 5, 6], dist1D(positions), { eps: 0.5, minPts: 3 });
  expect(out.clusters).toHaveLength(2);
  const sorted = out.clusters.map(c => c.slice().sort());
  expect(sorted).toContainEqual([1, 2, 3]);
  expect(sorted).toContainEqual([4, 5, 6]);
});

test('cluster — sparse points fall to noise when minPts not reached', () => {
  const positions = { 1: 0, 2: 5, 3: 10 };
  const out = cluster([1, 2, 3], dist1D(positions), { eps: 1, minPts: 3 });
  expect(out.clusters).toEqual([]);
  expect(out.noise.sort()).toEqual([1, 2, 3]);
});

test('cluster — border point joins an existing cluster (DBSCAN border rule)', () => {
  // Core trio: 0, 0.1, 0.2 at eps=0.3 minPts=3.
  // Border: 0.4 — within eps of 0.2 but its own neighborhood is only {0.2, 0.4} (count=2 < minPts).
  // DBSCAN: border points still attach to a reachable core cluster.
  const positions = { 1: 0, 2: 0.1, 3: 0.2, 4: 0.4 };
  const out = cluster([1, 2, 3, 4], dist1D(positions), { eps: 0.3, minPts: 3 });
  expect(out.clusters).toHaveLength(1);
  expect(out.clusters[0]!.sort()).toEqual([1, 2, 3, 4]);
  expect(out.noise).toEqual([]);
});

test('cluster — deterministic order across re-runs with identical inputs', () => {
  const positions = {
    1: 0, 2: 0.1, 3: 0.2,
    4: 5, 5: 5.1, 6: 5.2,
  };
  const ids = [1, 2, 3, 4, 5, 6];
  const opts = { eps: 0.5, minPts: 3 };
  const a = cluster(ids, dist1D(positions), opts);
  const b = cluster(ids, dist1D(positions), opts);
  expect(a.clusters).toEqual(b.clusters);
  expect(a.noise).toEqual(b.noise);
});
