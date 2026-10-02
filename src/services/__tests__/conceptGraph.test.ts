import { describe, expect, it } from "vitest";
import { resolveLlmGraph } from "@/services/conceptGraph";
import { extractJsonObject, LlmConceptGraphSchema, safeJsonParse, topologicalOrder, type LlmConceptGraph } from "@/types/schema";

const card = [{ front: "Q", back: "A" }];
const concept = (key: string, title = key) => ({
  key,
  title,
  description: `${title} description`,
  bloomLevel: "understand" as const,
  sourceChunkIds: ["C1", "C99"],
  flashcards: card,
});

let counter = 0;
const ids = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const handles = new Map([["C1", "11111111-1111-4111-8111-111111111111"]]);

describe("resolveLlmGraph", () => {
  it("breaks cycles, drops dangling/self edges, and keeps a DAG", () => {
    const llm: LlmConceptGraph = {
      concepts: [concept("a"), concept("b"), concept("c")],
      dependencies: [
        { conceptKey: "b", dependsOnKey: "a" },
        { conceptKey: "c", dependsOnKey: "b" },
        { conceptKey: "a", dependsOnKey: "c" },
        { conceptKey: "a", dependsOnKey: "a" },
        { conceptKey: "a", dependsOnKey: "missing" },
        { conceptKey: "b", dependsOnKey: "a" },
      ],
    };
    const graph = resolveLlmGraph(llm, handles, ids);
    expect(graph.edges).toHaveLength(2);
    expect(graph.droppedEdges).toBe(4);
    const order = topologicalOrder(
      graph.concepts.map((c) => c.id),
      graph.edges.map((e) => ({ from: e.parentConceptId, to: e.childConceptId })),
    );
    expect(order).not.toBeNull();
    expect(graph.concepts.map((c) => c.key)).toEqual(["a", "b", "c"]);
  });

  it("deduplicates concepts and maps chunk handles to UUIDs", () => {
    const llm: LlmConceptGraph = {
      concepts: [concept("x", "Entropy"), concept("y", "  entropy "), concept("x", "Other")],
      dependencies: [],
    };
    const graph = resolveLlmGraph(llm, handles, ids);
    expect(graph.concepts).toHaveLength(1);
    expect(graph.droppedConcepts).toBe(2);
    expect(graph.concepts[0]?.sourceChunkIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(graph.cards).toHaveLength(1);
  });
});

describe("defensive JSON helpers", () => {
  it("extracts a JSON object from fenced LLM output with braces inside strings", () => {
    const text = 'Here you go:\n```json\n{"a": "brace } inside", "b": {"c": 1}}\n```';
    expect(extractJsonObject(text)).toBe('{"a": "brace } inside", "b": {"c": 1}}');
    expect(extractJsonObject("no json")).toBeNull();
  });

  it("safeJsonParse never throws and reports schema errors", () => {
    expect(safeJsonParse("{not json", LlmConceptGraphSchema).ok).toBe(false);
    const invalid = safeJsonParse(JSON.stringify({ concepts: [], dependencies: [] }), LlmConceptGraphSchema);
    expect(invalid.ok).toBe(false);
  });
});
