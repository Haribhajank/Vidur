import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerEnv } from "@/lib/env";
import { isUuid, jsonError, jsonOk, logError, serviceErrorResponse } from "@/lib/http";
import { callMl } from "@/lib/mlClient";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getAuthenticatedUser } from "@/lib/supabase/server";
import { getStorageManager } from "@/services/storageManager";
import { toBookDto, type ApiError, type Book } from "@/types/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface RouteContext {
  readonly params: Promise<{ id: string }>;
}

const AcceptedSchema = z.object({ accepted: z.literal(true), bookId: z.uuid() });

/**
 * POST /api/books/:id/ingest — called by the browser after the direct upload finishes.
 * Verifies the real object size, flips the book to `processing`, and hands a short-lived signed
 * download URL to the ML Space. We wait only for the Space's "accepted" event; the job keeps
 * running there and reports back via the signed ingestion-complete callback.
 */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse<{ book: Book } | ApiError>> {
  const { id } = await context.params;
  if (!isUuid(id)) return jsonError(400, "INVALID_ID", "Book id must be a UUID");
  try {
    const user = await getAuthenticatedUser();
    if (user === null) return jsonError(401, "UNAUTHENTICATED", "Sign in required");

    const storage = getStorageManager();
    const verified = await storage.verifyUploadedObject(user.id, id);
    if (!verified.ok) return serviceErrorResponse("books.ingest.verify", verified.error);
    const book = verified.value;
    if (book.file_path === null) return jsonError(409, "INVALID_STATE", "Book has no uploaded file");

    const download = await storage.createIngestionDownloadUrl(book.file_path);
    if (!download.ok) return serviceErrorResponse("books.ingest.sign", download.error);

    const db = getSupabaseAdmin();
    const { data: claimed, error: claimError } = await db
      .from("books")
      .update({ status: "processing", ingest_error: null })
      .eq("id", id)
      .eq("status", "uploaded")
      .select("id")
      .maybeSingle();
    if (claimError !== null) return jsonError(500, "DATABASE_FAILURE", "Could not start ingestion");
    if (claimed === null) return jsonError(409, "INVALID_STATE", "Ingestion already started");

    const env = getServerEnv();
    const payload = JSON.stringify({
      bookId: id,
      downloadUrl: download.value,
      mimeType: book.mime_type,
      fileSizeBytes: book.file_size_bytes,
      callbackUrl: `${env.appBaseUrl}/api/books/${id}/ingestion-complete`,
    });

    const result = await callMl("ingest", payload, { until: "first", timeoutMs: 45_000 });
    const accepted = result.ok && AcceptedSchema.safeParse(result.output).success;
    if (!accepted) {
      logError("books.ingest.dispatch", new Error(result.ok ? "unexpected ingest response" : result.reason), {
        bookId: id,
      });
    }

    if (!accepted) {
      await db.from("books").update({ status: "uploaded" }).eq("id", id).eq("status", "processing");
      return jsonError(503, "ML_SERVICE_UNAVAILABLE", "The ingestion service is waking up. Please retry in a minute.");
    }

    const refreshed = await storage.getOwnedBook(user.id, id);
    if (!refreshed.ok) return serviceErrorResponse("books.ingest.refresh", refreshed.error);
    return jsonOk({ book: toBookDto(refreshed.value) }, 202);
  } catch (err) {
    logError("books.ingest", err, { bookId: id });
    return jsonError(500, "INTERNAL", "Internal server error");
  }
}
