export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtElapsed(s: number): string {
  const i = Math.floor(s);
  if (i < 60) return `${i}s`;
  if (i < 3600) return `${Math.floor(i / 60)}m ${i % 60}s`;
  return `${Math.floor(i / 3600)}h ${Math.floor((i % 3600) / 60)}m`;
}
