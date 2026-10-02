import "server-only";
import { getServerEnv } from "@/lib/env";
import { errorMessage, firstOutput, parseSseChunk } from "@/lib/gradioSse";
import { signPayload } from "@/lib/hmac";

export type MlEndpoint = "ingest" | "embed";

export type MlCallResult =
  | { readonly ok: true; readonly event: "generating" | "complete"; readonly output: unknown }
  | { readonly ok: false; readonly reason: string };

/**
 * Calls an endpoint on the ML Gradio Space (backend_ml/app.py).
 * The JSON body is HMAC-signed exactly like the callback (`hex(HMAC(secret, "{ts}.{body}"))`) and
 * passed as Gradio inputs `[body, timestamp, signature]`.
 *
 * `until: "first"` returns on the first output event and disconnects; the Space keeps running the
 * job (used for ingest, whose outcome arrives via the signed callback). `until: "complete"` waits
 * for the final output. Never throws.
 */
export async function callMl(
  endpoint: MlEndpoint,
  body: string,
  options: { readonly until: "first" | "complete"; readonly timeoutMs: number },
): Promise<MlCallResult> {
  const env = getServerEnv();
  const timestamp = Math.floor(Date.now() / 1000);
  const auth: Record<string, string> =
    env.mlServiceToken === null ? {} : { authorization: `Bearer ${env.mlServiceToken}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const base = `${env.mlServiceUrl}/gradio_api/call/${endpoint}`;

  try {
    const submit = await fetch(base, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ data: [body, String(timestamp), signPayload(env.mlSharedSecret, timestamp, body)] }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!submit.ok) return { ok: false, reason: `submit HTTP ${submit.status}` };
    const submitted: unknown = await submit.json().catch(() => null);
    const eventId =
      submitted !== null && typeof submitted === "object" && "event_id" in submitted ? submitted.event_id : null;
    if (typeof eventId !== "string") return { ok: false, reason: "submit returned no event_id" };

    const stream = await fetch(`${base}/${encodeURIComponent(eventId)}`, {
      headers: auth,
      signal: controller.signal,
      cache: "no-store",
    });
    if (!stream.ok || stream.body === null) return { ok: false, reason: `stream HTTP ${stream.status}` };

    const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { ok: false, reason: "stream ended without a result" };
      const parsed = parseSseChunk(buffer + value);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (event.event === "error") return { ok: false, reason: errorMessage(event.data) };
        if (event.event === "complete" || (event.event === "generating" && options.until === "first")) {
          void reader.cancel().catch(() => undefined);
          return { ok: true, event: event.event, output: firstOutput(event.data) };
        }
      }
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "request failed" };
  } finally {
    clearTimeout(timer);
  }
}
