// src/shared/vector-math.ts
//
// Pure vector primitives for the Quartermaster's cosine-similarity dedup confirm.
// No I/O, no deps. Operates on plain number arrays or Float32Array embeddings.

type Vec = number[] | Float32Array;

/** Cosine similarity of two equal-length vectors. Scale-invariant.
 *  Never returns NaN: a zero-norm vector (or a length mismatch) yields 0, so a
 *  degenerate embedding can never masquerade as a perfect match. */
export function cosine(a: Vec, b: Vec): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Componentwise mean of a set of equal-length vectors. Returns null for an
 *  empty input so callers must explicitly handle "no vectors to average". */
export function centroid(vectors: Array<Vec>): number[] | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0]!.length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) out[i]! += v[i]!;
  }
  for (let i = 0; i < dim; i++) out[i]! /= vectors.length;
  return out;
}
