/**
 * Minimal parser for Gradio's `/gradio_api/call/<name>/<event_id>` SSE stream, whose events are
 * `generating` (intermediate output), `complete` (final output), `error` and `heartbeat`.
 * Kept free of server-only imports so it can be unit-tested.
 */

export type GradioEventName = "generating" | "complete" | "error" | "heartbeat";

export interface GradioEvent {
  readonly event: GradioEventName | string;
  readonly data: string;
}

/** Splits a buffer into complete SSE events; returns the unconsumed tail for the next chunk. */
export function parseSseChunk(buffer: string): { events: GradioEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: GradioEvent[] = [];
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (event !== "message" || data.length > 0) events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

/** Gradio wraps outputs in an array; returns the first output, or undefined if unparseable. */
export function firstOutput(data: string): unknown {
  try {
    const parsed: unknown = JSON.parse(data);
    return Array.isArray(parsed) ? parsed[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Extracts the message from an `error` event payload (`{"error": "..."}` or `null`). */
export function errorMessage(data: string): string {
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed !== null && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // fall through
  }
  return "ML service error";
}
