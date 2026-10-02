import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getServerEnv } from "@/lib/env";
import { buildSignedHeaders } from "@/lib/hmac";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  EMBEDDING_DIMENSIONS,
  RetrievedChunkSchema,
  type Citation,
  type RetrievedChunk,
} from "@/types/schema";

const EmbedResponseSchema = z.object({
  embeddings: z.array(z.array(z.number()).length(EMBEDDING_DIMENSIONS)).min(1),
});

export interface RetrievalResult {
  readonly chunks: readonly RetrievedChunk[];
  readonly mode: "hybrid" | "keyword_only";
}

/**
 * Embeds a query on the ML Space. Returns null (never throws) on timeout, cold start or bad
 * payload so retrieval can degrade to keyword-only search instead of failing the request.
 */
export async function embedQuery(text: string, timeoutMs = 6000): Promise<number[] | null> {
  const env = getServerEnv();
  const body = JSON.stringify({ texts: [text.slice(0, 2000)] });
  try {
    const response = await fetch(`${env.mlServiceUrl}/embed`, {
      method: "POST",
      headers: buildSignedHeaders(env.mlSharedSecret, body),
      body,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const parsed = EmbedResponseSchema.safeParse(await response.json());
    return parsed.success ? (parsed.data.embeddings[0] ?? null) : null;
  } catch {
    return null;
  }
}

export async function hybridSearch(
  bookId: string,
  query: string,
  options: { matchCount?: number; db?: SupabaseClient; embedding?: number[] | null } = {},
): Promise<RetrievalResult> {
  const db = options.db ?? getSupabaseAdmin();
  const embedding = options.embedding !== undefined ? options.embedding : await embedQuery(query);
  const { data, error } = await db.rpc("hybrid_search_chunks", {
    p_book_id: bookId,
    p_query_text: query,
    p_query_embedding: embedding === null ? null : JSON.stringify(embedding),
    p_match_count: options.matchCount ?? 8,
  });
  if (error !== null) throw new Error(`Hybrid search failed: ${error.message}`);
  const parsed = z.array(RetrievedChunkSchema).safeParse(data ?? []);
  if (!parsed.success) throw new Error("Hybrid search returned an unexpected payload");
  return { chunks: parsed.data, mode: embedding === null ? "keyword_only" : "hybrid" };
}

/** Trims to a word boundary for citation snippets. */
export function makeSnippet(content: string, maxChars = 420): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > maxChars * 0.6 ? lastSpace : maxChars)}…`;
}

export function toCitation(chunk: Pick<RetrievedChunk, "id" | "content" | "page_start" | "page_end">): Citation {
  return {
    chunkId: chunk.id,
    pageStart: chunk.page_start,
    pageEnd: chunk.page_end,
    rawSnippet: makeSnippet(chunk.content),
  };
}
