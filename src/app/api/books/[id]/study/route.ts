import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid, jsonError, jsonOk, logError, serviceErrorResponse } from "@/lib/http";
import { learningOrder } from "@/lib/learningOrder";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getAuthenticatedUser } from "@/lib/supabase/server";
import { getStorageManager } from "@/services/storageManager";
import {
  BloomLevelSchema,
  FsrsStateSchema,
  toBookDto,
  type ApiError,
  type StudyCard,
  type StudyConcept,
  type StudyOverview,
} from "@/types/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ id: string }>;
}

const MAX_DUE_CARDS = 50;

const ConceptRowSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  bloom_level: BloomLevelSchema.nullable(),
});
const EdgeRowSchema = z.object({ parent_concept_id: z.uuid(), child_concept_id: z.uuid() });
const CardRowSchema = z.object({
  id: z.uuid(),
  concept_id: z.uuid(),
  front: z.string(),
  back: z.string(),
  state: FsrsStateSchema,
  due_date: z.string(),
});

/** GET /api/books/:id/study — the book's concepts in learning order and the owner's due flashcards. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse<StudyOverview | ApiError>> {
  const { id } = await context.params;
  if (!isUuid(id)) return jsonError(400, "INVALID_ID", "Book id must be a UUID");
  try {
    const user = await getAuthenticatedUser();
    if (user === null) return jsonError(401, "UNAUTHENTICATED", "Sign in required");
    const book = await getStorageManager().getOwnedBook(user.id, id);
    if (!book.ok) return serviceErrorResponse("books.study", book.error);
    if (book.value.status === "deleting") return jsonError(404, "NOT_FOUND", "Book not found");

    const db = getSupabaseAdmin();
    const conceptsResult = await db
      .from("concepts")
      .select("id,title,description,bloom_level")
      .eq("book_id", id)
      .order("created_at")
      .order("id");
    if (conceptsResult.error !== null) return jsonError(500, "DATABASE_FAILURE", "Could not load concepts");
    const conceptRows = z.array(ConceptRowSchema).parse(conceptsResult.data ?? []);
    const conceptIds = conceptRows.map((c) => c.id);

    let edges: z.infer<typeof EdgeRowSchema>[] = [];
    let cards: z.infer<typeof CardRowSchema>[] = [];
    if (conceptIds.length > 0) {
      const [edgeResult, cardResult] = await Promise.all([
        db.from("concept_relationships").select("parent_concept_id,child_concept_id").in("child_concept_id", conceptIds),
        db
          .from("fsrs_cards")
          .select("id,concept_id,front,back,state,due_date")
          .eq("user_id", user.id)
          .in("concept_id", conceptIds)
          .order("due_date"),
      ]);
      if (edgeResult.error !== null || cardResult.error !== null) {
        return jsonError(500, "DATABASE_FAILURE", "Could not load study data");
      }
      edges = z.array(EdgeRowSchema).parse(edgeResult.data ?? []);
      cards = z.array(CardRowSchema).parse(cardResult.data ?? []);
    }

    const prerequisites = new Map<string, string[]>();
    for (const edge of edges) {
      prerequisites.set(edge.child_concept_id, [...(prerequisites.get(edge.child_concept_id) ?? []), edge.parent_concept_id]);
    }
    const cardCounts = new Map<string, number>();
    for (const card of cards) cardCounts.set(card.concept_id, (cardCounts.get(card.concept_id) ?? 0) + 1);

    const byId = new Map(conceptRows.map((c) => [c.id, c]));
    const concepts: StudyConcept[] = learningOrder(
      conceptIds,
      edges.map((e) => ({ parent: e.parent_concept_id, child: e.child_concept_id })),
    ).map((conceptId) => {
      const row = byId.get(conceptId) as z.infer<typeof ConceptRowSchema>;
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        bloomLevel: row.bloom_level,
        prerequisiteIds: prerequisites.get(row.id) ?? [],
        cardCount: cardCounts.get(row.id) ?? 0,
      };
    });

    const now = Date.now();
    const due = cards.filter((c) => Date.parse(c.due_date) <= now);
    const dueCards: StudyCard[] = due.slice(0, MAX_DUE_CARDS).map((c) => ({
      id: c.id,
      conceptId: c.concept_id,
      front: c.front,
      back: c.back,
      state: c.state,
      dueDate: c.due_date,
    }));
    const upcoming = cards.find((c) => Date.parse(c.due_date) > now);

    return jsonOk({
      book: toBookDto(book.value),
      concepts,
      dueCards,
      totalCards: cards.length,
      nextDueDate: upcoming?.due_date ?? null,
    });
  } catch (err) {
    logError("books.study", err, { bookId: id });
    return jsonError(500, "INTERNAL", "Internal server error");
  }
}
