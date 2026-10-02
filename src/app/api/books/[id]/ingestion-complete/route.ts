import { after, NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "@/lib/hmac";
import { isUuid, jsonError, jsonOk, logError, logInfo } from "@/lib/http";
import { buildCurriculum } from "@/services/curriculumBuilder";
import { getStorageManager } from "@/services/storageManager";
import { IngestionCallbackSchema, safeJsonParse, type ApiError } from "@/types/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface RouteContext {
  readonly params: Promise<{ id: string }>;
}

interface CallbackResponse {
  readonly received: true;
  readonly rawFilePurged: boolean;
  readonly curriculumScheduled: boolean;
}

/**
 * POST /api/books/:id/ingestion-complete — HMAC-signed callback from the ML Space.
 * The ML service has already committed chunks + embeddings and set `status` in one transaction;
 * this hook (idempotently) auto-purges the raw file and schedules concept-graph generation.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse<CallbackResponse | ApiError>> {
  const { id } = await context.params;
  if (!isUuid(id)) return jsonError(400, "INVALID_ID", "Book id must be a UUID");

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return jsonError(400, "INVALID_BODY", "Unreadable body");
  }
  if (raw.length > 16_384) return jsonError(413, "PAYLOAD_TOO_LARGE", "Callback body too large");

  const env = getServerEnv();
  const valid = verifySignature(
    env.mlSharedSecret,
    raw,
    request.headers.get(TIMESTAMP_HEADER),
    request.headers.get(SIGNATURE_HEADER),
  );
  if (!valid) return jsonError(401, "INVALID_SIGNATURE", "Signature verification failed");

  const parsed = safeJsonParse(raw, IngestionCallbackSchema);
  if (!parsed.ok) return jsonError(400, "INVALID_BODY", parsed.error);
  if (parsed.data.bookId !== id) return jsonError(400, "ID_MISMATCH", "Body bookId does not match route");

  try {
    const storage = getStorageManager();
    const book = await storage.getBookById(id);
    if (!book.ok) {
      return book.error.code === "NOT_FOUND"
        ? jsonOk({ received: true, rawFilePurged: false, curriculumScheduled: false })
        : jsonError(500, "DATABASE_FAILURE", "Book lookup failed");
    }

    if (parsed.data.status === "failed") {
      const marked = await storage.markIngestionFailed(id, parsed.data.error);
      if (!marked.ok) logError("ingestion.callback.failed", marked.error, { bookId: id });
      return jsonOk({ received: true, rawFilePurged: marked.ok, curriculumScheduled: false });
    }

    if (book.value.status !== "indexed") {
      return jsonError(409, "INVALID_STATE", `Book is ${book.value.status}, expected indexed`);
    }

    const purge = await storage.purgeRawFile(id);
    if (!purge.ok) logError("ingestion.callback.purge", purge.error, { bookId: id });

    const shouldBuild = book.value.graph_status === "pending" || book.value.graph_status === "failed";
    if (shouldBuild) {
      after(async () => {
        await buildCurriculum(id);
      });
    }

    logInfo("ingestion.callback.indexed", { bookId: id, chunkCount: parsed.data.chunkCount, purged: purge.ok && purge.value.purged });
    return jsonOk({ received: true, rawFilePurged: purge.ok && purge.value.purged, curriculumScheduled: shouldBuild });
  } catch (err) {
    logError("ingestion.callback", err, { bookId: id });
    return jsonError(500, "INTERNAL", "Internal server error");
  }
}
