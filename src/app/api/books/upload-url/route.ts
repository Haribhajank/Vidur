import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabase/server";
import { jsonError, jsonOk, logError, serviceErrorResponse } from "@/lib/http";
import { getStorageManager } from "@/services/storageManager";
import { parseRequestJson, UploadUrlRequestSchema, type ApiError, type UploadUrlResponse } from "@/types/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXTENSION_BY_MIME = { "application/pdf": "pdf", "application/epub+zip": "epub" } as const;

/**
 * POST /api/books/upload-url — quota check + reservation + signed direct-to-Storage upload URL.
 * The browser then PUTs the file straight to Supabase Storage (bucket enforces 25 MB + MIME).
 */
export async function POST(request: Request): Promise<NextResponse<UploadUrlResponse | ApiError>> {
  try {
    const user = await getAuthenticatedUser();
    if (user === null) return jsonError(401, "UNAUTHENTICATED", "Sign in required");

    const body = await parseRequestJson(request, UploadUrlRequestSchema, 4096);
    if (!body.ok) return jsonError(400, "INVALID_BODY", body.error);

    const extension = body.data.fileName.split(".").pop()?.toLowerCase();
    if (extension !== EXTENSION_BY_MIME[body.data.mimeType]) {
      return jsonError(415, "UNSUPPORTED_FILE", "File extension does not match its type (PDF or EPUB only)");
    }

    const result = await getStorageManager().createSignedUpload(user.id, body.data);
    if (!result.ok) return serviceErrorResponse("books.uploadUrl", result.error);
    return jsonOk(result.value, 201);
  } catch (err) {
    logError("books.uploadUrl", err);
    return jsonError(500, "INTERNAL", "Internal server error");
  }
}
