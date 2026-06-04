// src/worker/route-class.ts
// Pure classifier: decides which engine serves a request. The ONLY source of truth
// for read/write routing in the threaded worker. Unknown paths → 'write' (safe: the
// writer engine can serve anything; a reader is read-only and must never get a write).
export type RouteClass = 'read' | 'write' | 'control';

// Pure corpus reads that a read-only reader engine can serve. Every other path
// (writes, /stats which needs writer-local indexing state, control endpoints)
// falls through to the writer.
const READ_PATHS = new Set<string>([
  '/search/all', '/search/memory', '/search/skill', '/search/observations',
  '/get_full', '/observation/full', '/inject/context',
  '/observations/recent', '/recall/list',
]);

export function classifyRoute(method: string, pathname: string): RouteClass {
  if (method === 'GET' && pathname === '/health') return 'control';
  if (READ_PATHS.has(pathname)) return 'read';
  return 'write';
}
