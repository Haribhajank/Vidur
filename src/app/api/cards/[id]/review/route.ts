import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid, jsonError, jsonOk, logError } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getAuthenticatedUser } from "@/lib/supabase/server";
import { defaultFsrs, fromCardDto, toCardRowUpdate } from "@/services/fsrsEngine";
import { FsrsStateSchema, parseRequestJson, RatingSchema, type ApiError, type RatingValue } from "@/types/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ id: string }>;
}

const ReviewRequestSchema = z.object({ rating: RatingSchema }).strict();

const CardRowSchema = z.object({
  id: z.uuid(),
  concept_id: z.uuid(),
  user_id: z.uuid(),
  front: z.string(),
  back: z.string(),
  stability: z.number().nullable(),
  difficulty: z.number().nullable(),
  elapsed_days: z.number().int(),
  scheduled_days: z.number().int(),
  reps: z.number().int(),
  lapses: z.number().int(),
  learning_step: z.number().int(),
  state: FsrsStateSchema,
  last_review: z.string().nullable(),
  due_date: z.string(),
});

interface ReviewResponse {
  readonly cardId: string;
  readonly state: z.infer<typeof FsrsStateSchema>;
  readonly dueDate: string;
  readonly scheduledDays: number;
  readonly stability: number;
  readonly difficulty: number;
  readonly nextPreview: Readonly<Record<RatingValue, string>>;
}

/** POST /api/cards/:id/review — applies an Again/Hard/Good/Easy rating via FSRS-4.5. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse<ReviewResponse | ApiError>> {
  const { id } = await context.params;
  if (!isUuid(id)) return jsonError(400, "INVALID_ID", "Card id must be a UUID");
  try {
    const user = await getAuthenticatedUser();
    if (user === null) return jsonError(401, "UNAUTHENTICATED", "Sign in required");
    const body = await parseRequestJson(request, ReviewRequestSchema, 256);
    if (!body.ok) return jsonError(400, "INVALID_BODY", body.error);

    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from("fsrs_cards")
      .select("id,concept_id,user_id,front,back,stability,difficulty,elapsed_days,scheduled_days,reps,lapses,learning_step,state,last_review,due_date")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error !== null) return jsonError(500, "DATABASE_FAILURE", "Card lookup failed");
    const row = CardRowSchema.safeParse(data);
    if (!row.success) return jsonError(404, "NOT_FOUND", "Card not found");

    const card = fromCardDto({
      id: row.data.id,
      conceptId: row.data.concept_id,
      userId: row.data.user_id,
      front: row.data.front,
      back: row.data.back,
      stability: row.data.stability,
      difficulty: row.data.difficulty,
      elapsedDays: row.data.elapsed_days,
      scheduledDays: row.data.scheduled_days,
      reps: row.data.reps,
      lapses: row.data.lapses,
      learningStep: row.data.learning_step,
      state: row.data.state,
      lastReview: row.data.last_review,
      dueDate: row.data.due_date,
    });

    const now = new Date();
    const result = defaultFsrs.review(card, body.data.rating, now);
    const update = toCardRowUpdate(result.card);

    const { data: updated, error: updateError } = await db
      .from("fsrs_cards")
      .update(update)
      .eq("id", id)
      .eq("user_id", user.id)
      .eq("reps", row.data.reps)
      .select("id")
      .maybeSingle();
    if (updateError !== null) return jsonError(500, "DATABASE_FAILURE", "Failed to save review");
    if (updated === null) return jsonError(409, "CONFLICT", "Card was reviewed concurrently; refresh and retry");

    const { error: logErr } = await db.from("review_logs").insert({
      card_id: id,
      user_id: user.id,
      rating: result.log.rating,
      state_before: result.log.stateBefore,
      stability_after: result.log.stabilityAfter,
      difficulty_after: result.log.difficultyAfter,
      elapsed_days: result.log.elapsedDays,
      scheduled_days: result.log.scheduledDays,
      reviewed_at: result.log.reviewedAt.toISOString(),
    });
    if (logErr !== null) logError("cards.review.log", logErr, { cardId: id });

    return jsonOk({
      cardId: id,
      state: result.card.state,
      dueDate: result.card.due.toISOString(),
      scheduledDays: result.card.scheduledDays,
      stability: update.stability,
      difficulty: update.difficulty,
      nextPreview: defaultFsrs.previewLabels(result.card, result.card.due),
    });
  } catch (err) {
    logError("cards.review", err, { cardId: id });
    return jsonError(500, "INTERNAL", "Internal server error");
  }
}
