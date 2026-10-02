import type { z } from "zod";
import { ApiErrorSchema, safeJsonParse } from "@/types/schema";

export type FetchResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

/** Browser-side JSON fetch that never throws and validates the response shape. */
export async function requestJson<T>(url: string, schema: z.ZodType<T>, init?: RequestInit): Promise<FetchResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...init?.headers } });
  } catch {
    return { ok: false, status: 0, message: "Network error. Check your connection and try again." };
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const parsed = safeJsonParse(text, ApiErrorSchema);
    return { ok: false, status: response.status, message: parsed.ok ? parsed.data.error.message : `Request failed (${response.status})` };
  }
  const parsed = safeJsonParse(text, schema);
  return parsed.ok ? { ok: true, data: parsed.data } : { ok: false, status: response.status, message: "Unexpected response from server." };
}
