import { NextResponse } from "next/server";
import { jsonError, jsonOk, logError, serviceErrorResponse } from "@/lib/http";
import { getAuthenticatedUser } from "@/lib/supabase/server";
import { getStorageManager } from "@/services/storageManager";
import { toBookDto, type ApiError, type StorageOverview } from "@/types/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/storage/quota — storage usage + active books for the Manage & Purge Books modal. */
export async function GET(): Promise<NextResponse<StorageOverview | ApiError>> {
  try {
    const user = await getAuthenticatedUser();
    if (user === null) return jsonError(401, "UNAUTHENTICATED", "Sign in required");
    const storage = getStorageManager();
    const [quota, books] = await Promise.all([storage.getQuota(user.id), storage.listBooks(user.id)]);
    if (!quota.ok) return serviceErrorResponse("storage.quota", quota.error);
    if (!books.ok) return serviceErrorResponse("storage.books", books.error);
    return jsonOk({ quota: quota.value, books: books.value.map(toBookDto) });
  } catch (err) {
    logError("storage.quota", err);
    return jsonError(500, "INTERNAL", "Internal server error");
  }
}
