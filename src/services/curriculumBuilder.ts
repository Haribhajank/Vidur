import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logError, logInfo } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getLlmOrchestrator, type LlmOrchestrator } from "@/services/llmOrchestrator";

const INSERT_BATCH = 200;

async function insertInBatches(db: SupabaseClient, table: string, rows: readonly Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const { error } = await db.from(table).insert(rows.slice(i, i + INSERT_BATCH));
    if (error !== null) throw new Error(`Insert into ${table} failed: ${error.message}`);
  }
}

/**
 * Generates and persists the concept DAG + FSRS cards for an indexed book.
 * Idempotent and single-flight: the `graph_status` compare-and-set ensures only one generation
 * runs per book; any previous partial graph is replaced. On failure, partial rows are removed and
 * `graph_status` is set to `failed` so the user can retry.
 */
export async function buildCurriculum(
  bookId: string,
  deps: { db?: SupabaseClient; llm?: LlmOrchestrator } = {},
): Promise<{ concepts: number; edges: number; cards: number } | null> {
  const db = deps.db ?? getSupabaseAdmin();

  const { data: claimed, error: claimError } = await db
    .from("books")
    .update({ graph_status: "generating" })
    .eq("id", bookId)
    .eq("status", "indexed")
    .in("graph_status", ["pending", "failed"])
    .select("id,user_id")
    .maybeSingle();
  if (claimError !== null) {
    logError("curriculum.claim", claimError, { bookId });
    return null;
  }
  if (claimed === null) return null;
  const userId = String((claimed as { user_id: unknown }).user_id);

  try {
    const { graph, usage } = await (deps.llm ?? getLlmOrchestrator()).generateConceptGraph(bookId);

    const { error: clearError } = await db.from("concepts").delete().eq("book_id", bookId);
    if (clearError !== null) throw new Error(`Failed to clear previous graph: ${clearError.message}`);

    await insertInBatches(
      db,
      "concepts",
      graph.concepts.map((c) => ({
        id: c.id,
        book_id: bookId,
        title: c.title,
        description: c.description,
        bloom_level: c.bloomLevel,
        source_chunk_ids: c.sourceChunkIds,
      })),
    );
    await insertInBatches(
      db,
      "concept_relationships",
      graph.edges.map((e) => ({
        parent_concept_id: e.parentConceptId,
        child_concept_id: e.childConceptId,
        relationship_type: "prerequisite",
      })),
    );
    await insertInBatches(
      db,
      "fsrs_cards",
      graph.cards.map((card) => ({ concept_id: card.conceptId, user_id: userId, front: card.front, back: card.back })),
    );

    const { error: doneError } = await db.from("books").update({ graph_status: "ready" }).eq("id", bookId);
    if (doneError !== null) throw new Error(`Failed to mark graph ready: ${doneError.message}`);

    const summary = { concepts: graph.concepts.length, edges: graph.edges.length, cards: graph.cards.length };
    logInfo("curriculum.ready", { bookId, ...summary, droppedEdges: graph.droppedEdges, ...usage });
    return summary;
  } catch (err) {
    logError("curriculum.failed", err, { bookId });
    await db.from("concepts").delete().eq("book_id", bookId);
    await db.from("books").update({ graph_status: "failed" }).eq("id", bookId).eq("graph_status", "generating");
    return null;
  }
}
