/**
 * Orders concepts so prerequisites come before dependents (Kahn's algorithm), using the original
 * order as the tiebreak. Edges pointing at unknown ids are ignored; if a cycle slips past the DB
 * trigger, the remaining concepts are appended rather than dropped.
 */
export function learningOrder(ids: readonly string[], edges: readonly { parent: string; child: string }[]): string[] {
  const position = new Map(ids.map((id, index) => [id, index]));
  const indegree = new Map(ids.map((id) => [id, 0]));
  const children = new Map<string, string[]>();
  for (const { parent, child } of edges) {
    if (!position.has(parent) || !position.has(child) || parent === child) continue;
    indegree.set(child, (indegree.get(child) ?? 0) + 1);
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const ready = ids.filter((id) => indegree.get(id) === 0);
  const ordered: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
    const next = ready.shift() as string;
    ordered.push(next);
    for (const child of children.get(next) ?? []) {
      const remaining = (indegree.get(child) ?? 1) - 1;
      indegree.set(child, remaining);
      if (remaining === 0) ready.push(child);
    }
  }
  if (ordered.length === ids.length) return ordered;
  const placed = new Set(ordered);
  return [...ordered, ...ids.filter((id) => !placed.has(id))];
}
