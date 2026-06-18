// src/eval/oracle.ts — deterministic freshness ground truth for temporal queries.
// "The latest fact about entity X" = the entity-matching doc with the greatest
// created_at_epoch. Recomputed each run, so it never goes stale. No I/O.

export interface EntityDoc {
  doc_id: string;
  created_at_epoch: number;
  text: string;
}

export function matchesEntity(doc: EntityDoc, entity: string): boolean {
  return doc.text.toLowerCase().includes(entity.toLowerCase());
}

export function freshestDoc(docs: EntityDoc[], entity: string): EntityDoc | undefined {
  let best: EntityDoc | undefined;
  for (const d of docs) {
    if (!matchesEntity(d, entity)) continue;
    if (!best || d.created_at_epoch > best.created_at_epoch) best = d;
  }
  return best;
}

export function staleEntityDocs(docs: EntityDoc[], entity: string): Set<string> {
  const fresh = freshestDoc(docs, entity);
  const stale = new Set<string>();
  if (!fresh) return stale;
  for (const d of docs) {
    if (matchesEntity(d, entity) && d.doc_id !== fresh.doc_id) stale.add(d.doc_id);
  }
  return stale;
}
