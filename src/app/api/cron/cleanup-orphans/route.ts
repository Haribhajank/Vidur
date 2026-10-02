import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { safeEqualStrings } from "@/lib/hmac";
import { jsonError, jsonOk, logError, logInfo, serviceErrorResponse } from "@/lib/http";
import { getStorageManager, type CleanupReport } from "@/services/storageManager";
import type { ApiError } from "@/types/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/cron/cleanup-orphans — invoked by Vercel Cron (daily on Hobby) with
 * `Authorization: Bearer ${CRON_SECRET}`. Can also be triggered manually with the same header.
 */
export async function GET(request: Request): Promise<NextResponse<CleanupReport | ApiError>> {
  const env = getServerEnv();
  const header = request.headers.get("authorization") ?? "";
  if (!safeEqualStrings(header, `Bearer ${env.cronSecret}`)) {
    return jsonError(401, "UNAUTHORIZED", "Invalid cron credentials");
  }
  try {
    const result = await getStorageManager().cleanupOrphans();
    if (!result.ok) return serviceErrorResponse("cron.cleanup", result.error);
    logInfo("cron.cleanup", { ...result.value, errors: result.value.errors.length });
    return jsonOk(result.value);
  } catch (err) {
    logError("cron.cleanup", err);
    return jsonError(500, "INTERNAL", "Internal server error");
  }
}
