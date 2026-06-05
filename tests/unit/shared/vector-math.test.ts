import { test, expect } from 'bun:test';
import { cosine, centroid } from '../../../src/shared/vector-math.ts';
test('cosine of identical vectors is 1', () => { expect(cosine([1,2,3],[1,2,3])).toBeCloseTo(1, 6); });
test('cosine of orthogonal vectors is 0', () => { expect(cosine([1,0],[0,1])).toBeCloseTo(0, 6); });
test('cosine is scale-invariant', () => { expect(cosine([1,2,3],[2,4,6])).toBeCloseTo(1, 6); });
test('cosine handles Float32Array', () => { expect(cosine(Float32Array.from([1,2,3]), Float32Array.from([1,2,3]))).toBeCloseTo(1, 6); });
test('zero vector yields 0, not NaN', () => { const c = cosine([0,0],[1,1]); expect(Number.isNaN(c)).toBe(false); expect(c).toBe(0); });
test('centroid averages componentwise', () => { expect(centroid([[1,1],[3,3]])).toEqual([2,2]); });
test('centroid of empty is null', () => { expect(centroid([])).toBeNull(); });
