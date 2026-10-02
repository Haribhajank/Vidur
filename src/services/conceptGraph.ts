import { randomUUID } from "node:crypto";
import { topologicalOrder, type BloomLevel, type LlmConceptGraph } from "@/types/schema";

export interface ResolvedConcept {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly bloomLevel: BloomLevel;
  readonly sourceChunkIds: readonly string[];
}

export interface ResolvedEdge {
  /** Prerequisite. */
  readonly parentConceptId: string;
  /** Concept that depends_on the parent. */
  readonly childConceptId: string;
}

export interface ResolvedCard {
  readonly conceptId: string;
  readonly front: string;
  readonly back: string;
}

export interface ResolvedConceptGraph {
  readonly concepts: readonly ResolvedConcept[];
  readonly edges: readonly ResolvedEdge[];
  readonly cards: readonly ResolvedCard[];
  readonly droppedEdges: number;
  readonly droppedConcepts: number;
}

const normalizeKey = (key: string): string => key.trim().toLowerCase();
const normalizeTitle = (title: string): string => title.trim().replace(/\s+/g, " ").toLowerCase();

/** True when `target` is reachable from `start` following parent → child edges. */
function reachable(adjacency: ReadonlyMap<string, ReadonlySet<string>>, start: string, target: string): boolean {
  const stack = [start];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop() as string;
    if (node === target) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adjacency.get(node) ?? []) stack.push(next);
  }
  return false;
}

/**
 * Converts raw LLM output into a validated DAG:
 *  - deduplicates concepts by key and by normalized title,
 *  - maps short chunk handles (e.g. "C12") back to chunk UUIDs, discarding unknown handles,
 *  - drops dangling / self / duplicate dependencies,
 *  - greedily inserts edges, skipping any that would close a cycle (so the result is acyclic).
 */
export function resolveLlmGraph(
  llm: LlmConceptGraph,
  chunkHandles: ReadonlyMap<string, string>,
  generateId: () => string = randomUUID,
): ResolvedConceptGraph {
  const byKey = new Map<string, ResolvedConcept>();
  const seenTitles = new Set<string>();
  const cards: ResolvedCard[] = [];
  let droppedConcepts = 0;

  for (const raw of llm.concepts) {
    const key = normalizeKey(raw.key);
    const title = raw.title.trim();
    const titleKey = normalizeTitle(title);
    if (key === "" || title === "" || byKey.has(key) || seenTitles.has(titleKey)) {
      droppedConcepts++;
      continue;
    }
    const sourceChunkIds = [
      ...new Set(raw.sourceChunkIds.map((h) => chunkHandles.get(h.trim())).filter((id): id is string => id !== undefined)),
    ];
    const concept: ResolvedConcept = {
      id: generateId(),
      key,
      title,
      description: raw.description.trim(),
      bloomLevel: raw.bloomLevel,
      sourceChunkIds,
    };
    byKey.set(key, concept);
    seenTitles.add(titleKey);
    for (const card of raw.flashcards) {
      const front = card.front.trim();
      const back = card.back.trim();
      if (front !== "" && back !== "") cards.push({ conceptId: concept.id, front, back });
    }
  }

  const adjacency = new Map<string, Set<string>>();
  const edges: ResolvedEdge[] = [];
  const edgeKeys = new Set<string>();
  let droppedEdges = 0;

  for (const dep of llm.dependencies) {
    const child = byKey.get(normalizeKey(dep.conceptKey));
    const parent = byKey.get(normalizeKey(dep.dependsOnKey));
    if (child === undefined || parent === undefined || child.id === parent.id) {
      droppedEdges++;
      continue;
    }
    const edgeKey = `${parent.id}>${child.id}`;
    if (edgeKeys.has(edgeKey) || reachable(adjacency, child.id, parent.id)) {
      droppedEdges++;
      continue;
    }
    edgeKeys.add(edgeKey);
    const children = adjacency.get(parent.id) ?? new Set<string>();
    children.add(child.id);
    adjacency.set(parent.id, children);
    edges.push({ parentConceptId: parent.id, childConceptId: child.id });
  }

  const concepts = [...byKey.values()];
  const order = topologicalOrder(
    concepts.map((c) => c.id),
    edges.map((e) => ({ from: e.parentConceptId, to: e.childConceptId })),
  );
  if (order === null) {
    throw new Error("Invariant violated: resolved concept graph is not acyclic");
  }
  const rank = new Map(order.map((id, index) => [id, index]));
  concepts.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));

  return { concepts, edges, cards, droppedEdges, droppedConcepts };
}
