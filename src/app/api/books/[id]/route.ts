import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabase/server";
import { isUuid, jsonError, jsonOk, logError, logInfo, serviceErrorResponse } from "@/lib/http";
import { getStorageManager } from "@/services/storageManager";
import {
  parseRequestJson,
  toBookDto,
  UpdateBookRequestSchema,
  type ApiError,
  type Book,
  type PurgeReport,
  type UpdateBookResponse,
} from "@/types/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ id: string }>;
}

async function resolveContext(
  context: RouteContext,
): Promise<{ ok: true; userId: string; bookId: string } | { ok: false; response: NextResponse<ApiError> }> {
  const { id } = await context.params;
  if (!isUuid(id)) return { ok: false, response: jsonError(400, "INVALID_ID", "Book id must be a UUID") };
  const user = await getAuthenticatedUser();
  if (user === null) return { ok: false, response: jsonError(401, "UNAUTHENTICATED", "Sign in required") };
  return { ok: true, userId: user.id, bookId: id };
}

/** GET /api/books/:id — book metadata for the owner. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse<{ book: Book } | ApiError>> {
  try {
    const ctx = await resolveContext(context);
    if (!ctx.ok) return ctx.response;
    const result = await getStorageManager().getOwnedBook(ctx.userId, ctx.bookId);
    if (!result.ok) return serviceErrorResponse("books.get", result.error);
    if (result.value.status === "deleting") return jsonError(404, "NOT_FOUND", "Book not found");
    return jsonOk({ book: toBookDto(result.value) });
  } catch (err) {
    logError("books.get", err);
    return jsonError(500, "INTERNAL", "Internal server error");
  }
}

/** PATCH /api/books/:id — toggle "Keep Original PDF". Disabling purges the raw file immediately. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse<UpdateBookResponse | ApiError>> {
  try {
    const ctx = await resolveContext(context);
    if (!ctx.ok) return ctx.response;
    const body = await parseRequestJson(request, UpdateBookRequestSchema, 1024);
    if (!body.ok) return jsonError(400, "INVALID_BODY", body.error);

    const result = await getStorageManager().setKeepOriginal(ctx.userId, ctx.bookId, body.data.keepOriginal);
    if (!result.ok) return serviceErrorResponse("books.patch", result.error);
    return jsonOk({ book: toBookDto(result.value) });
  } catch (err) {
    logError("books.patch", err);
    return jsonError(500, "INTERNAL", "Internal server error");
  }
}

/**
 * DELETE /api/books/:id — hard cascade purge.
 * Postgres `ON DELETE CASCADE` removes chunks, embeddings, concepts, relationships, FSRS cards,
 * review logs and assessment logs; the raw file is removed from Supabase Storage. If Storage is
 * temporarily unavailable the response still succeeds (records are gone, the book is no longer
 * visible) and the orphaned object is reported as deferred to the cleanup cron.
 */
export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse<PurgeReport | ApiError>> {
  try {
    const ctx = await resolveContext(context);
    if (!ctx.ok) return ctx.response;
    const result = await getStorageManager().purgeBook(ctx.userId, ctx.bookId);
    if (!result.ok) return serviceErrorResponse("books.delete", result.error);
    logInfo("books.delete", { ...result.value });
    return jsonOk(result.value);
  } catch (err) {
    logError("books.delete", err);
    return jsonError(500, "INTERNAL", "Internal server error");
  }
}
