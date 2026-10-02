import { jsonError, logError, logInfo } from "@/lib/http";
import { getAuthenticatedUser } from "@/lib/supabase/server";
import { getLlmOrchestrator } from "@/services/llmOrchestrator";
import { getStorageManager } from "@/services/storageManager";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { parseRequestJson, TutorRequestSchema } from "@/types/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/tutor/stream — Server-Sent Events stream of the Socratic tutor.
 * Event order: `citations` → `text`* → `usage` | `error`, then `done`.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await getAuthenticatedUser();
    if (user === null) return jsonError(401, "UNAUTHENTICATED", "Sign in required");

    const body = await parseRequestJson(request, TutorRequestSchema, 256 * 1024);
    if (!body.ok) return jsonError(400, "INVALID_BODY", body.error);

    const book = await getStorageManager().getOwnedBook(user.id, body.data.bookId);
    if (!book.ok || book.value.status === "deleting") return jsonError(404, "NOT_FOUND", "Book not found");
    if (book.value.status !== "indexed") return jsonError(409, "NOT_READY", "This book is still being processed");

    let conceptTitle: string | null = null;
    if (body.data.conceptId !== undefined) {
      const { data } = await getSupabaseAdmin()
        .from("concepts")
        .select("title")
        .eq("id", body.data.conceptId)
        .eq("book_id", body.data.bookId)
        .maybeSingle();
      conceptTitle = typeof (data as { title?: unknown } | null)?.title === "string" ? (data as { title: string }).title : null;
    }

    const encoder = new TextEncoder();
    const orchestrator = getLlmOrchestrator();
    const abort = new AbortController();
    request.signal.addEventListener("abort", () => abort.abort(), { once: true });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        try {
          for await (const event of orchestrator.streamSocraticTutor({
            bookId: body.data.bookId,
            message: body.data.message,
            history: body.data.history,
            conceptTitle,
            signal: abort.signal,
          })) {
            send(event.type, event);
            if (event.type === "usage") logInfo("tutor.usage", { bookId: body.data.bookId, ...event.usage });
          }
        } catch (err) {
          logError("tutor.stream", err);
          send("error", { type: "error", code: "INTERNAL", message: "Stream interrupted" });
        } finally {
          send("done", {});
          controller.close();
        }
      },
      cancel() {
        abort.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (err) {
    logError("tutor.stream", err);
    return jsonError(500, "INTERNAL", "Internal server error");
  }
}
