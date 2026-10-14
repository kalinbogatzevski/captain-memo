// Synthetic 4-dimension vectors for the IVF store tests. Nothing here comes from a real corpus.

/** Deterministic vectors with a direction, spread over the sphere. */
export function realVectors(n: number, prefix: string, seed = 1): Array<{ id: string; embedding: number[] }> {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, embedding: [rnd() + 0.01, rnd(), rnd(), rnd()] }));
}

/** Vectors with no direction, as an embed failure stored until 0.48.0. */
export const zeros = (n: number, prefix: string): Array<{ id: string; embedding: number[] }> =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, embedding: [0, 0, 0, 0] }));
