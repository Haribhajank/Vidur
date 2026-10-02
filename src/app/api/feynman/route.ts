import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, logError } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getAuthenticatedUser } from "@/lib/supabase/server";
import { getLlmOrchestrator, LlmError } from "@/services/llmOrchestrator";
import { FeynmanRequestSchema, parseRequestJson, type ApiError, type Citation, type FeynmanEvaluation } from "@/types/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const OwnedConceptSchema = z.object({ id: z.uuid(), book_id: z.uuid(), books: z.object({ user_id: z.uuid(), status: z.string() }) });

interface FeynmanResponse {
  readonly evaluation: FeynmanEvaluation;
  readonly citations: readonly Citation[];
}

const STATUS_BY_LLM_CODE: Record<LlmError["code"], number> = {
  NOT_FOUND: 404,
  REFUSED: 422,
  INVALID_OUTPUT: 502,
  UPSTREAM_UNAVAILABLE: 503,
  CONFIG: 500,
};

/** POST /api/feynman — evaluates a plain-language explanation and logs it to assessment_logs. */
export async function POST(request: Request): Promise<NextResponse<FeynmanResponse | ApiError>> {
  try {
    const user = await getAuthenticatedUser();
    if (user === null) return jsonError(401, "UNAUTHENTICATED", "Sign in required");
    const body = await parseRequestJson(request, FeynmanRequestSchema, 32 * 1024);
    if (!body.ok) return jsonError(400, "INVALID_BODY", body.error);

    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from("concepts")
      .select("id,book_id,books!inner(user_id,status)")
      .eq("id", body.data.conceptId)
      .maybeSingle();
    if (error !== null) return jsonError(500, "DATABASE_FAILURE", "Concept lookup failed");
    const concept = OwnedConceptSchema.safeParse(data);
    if (!concept.success || concept.data.books.user_id !== user.id || concept.data.books.status === "deleting") {
      return jsonError(404, "NOT_FOUND", "Concept not found");
    }

    const orchestrator = getLlmOrchestrator();
    const result = await orchestrator.evaluateFeynman({
      bookId: concept.data.book_id,
      conceptId: concept.data.id,
      explanation: body.data.explanation,
    });

    const { error: logErr } = await db.from("assessment_logs").insert({
      book_id: concept.data.book_id,
      concept_id: concept.data.id,
      user_id: user.id,
      explanation: body.data.explanation,
      evaluation: result.evaluation,
      overall_score: result.evaluation.overallScore,
      model: orchestrator.modelId,
    });
    if (logErr !== null) logError("feynman.log", logErr, { conceptId: concept.data.id });

    return jsonOk({ evaluation: result.evaluation, citations: result.citations });
  } catch (err) {
    if (err instanceof LlmError) {
      const status = STATUS_BY_LLM_CODE[err.code];
      if (status >= 500) logError("feynman", err);
      return jsonError(status, err.code, status === 500 ? "Internal server error" : err.message);
    }
    logError("feynman", err);
    return jsonError(500, "INTERNAL", "Internal server error");
  }
}
