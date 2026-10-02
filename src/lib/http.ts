import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { ApiError } from "@/types/schema";

export function jsonError(status: number, code: string, message: string, details?: unknown): NextResponse<ApiError> {
  const body: ApiError = { error: details === undefined ? { code, message } : { code, message, details } };
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function jsonOk<T>(data: T, status = 200): NextResponse<T> {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

const UuidSchema = z.uuid();

export function isUuid(value: string): boolean {
  return UuidSchema.safeParse(value).success;
}

export function logError(scope: string, err: unknown, context: Record<string, unknown> = {}): void {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause !== undefined ? String((err.cause as { message?: unknown }).message ?? err.cause) : undefined;
  console.error(JSON.stringify({ level: "error", scope, message, cause, ...context }));
}

export function logInfo(scope: string, context: Record<string, unknown>): void {
  console.info(JSON.stringify({ level: "info", scope, ...context }));
}

/** Maps a typed service error (StorageError / LlmError shape) to a JSON response. */
export function serviceErrorResponse(
  scope: string,
  error: { code: string; message: string; httpStatus?: number },
  fallbackStatus = 500,
): NextResponse<ApiError> {
  const status = error.httpStatus ?? fallbackStatus;
  if (status >= 500) logError(scope, error);
  const message = status >= 500 && status !== 502 && status !== 507 ? "Internal server error" : error.message;
  return jsonError(status, error.code, message);
}
