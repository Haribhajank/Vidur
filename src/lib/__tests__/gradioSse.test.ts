import { describe, expect, it } from "vitest";
import { errorMessage, firstOutput, parseSseChunk } from "@/lib/gradioSse";

describe("parseSseChunk", () => {
  it("parses complete events and keeps the partial tail", () => {
    const { events, rest } = parseSseChunk('event: generating\ndata: [{"accepted": true}]\n\nevent: comp');
    expect(events).toEqual([{ event: "generating", data: '[{"accepted": true}]' }]);
    expect(rest).toBe("event: comp");
    const next = parseSseChunk(`${rest}lete\ndata: [1]\n\n`);
    expect(next.events).toEqual([{ event: "complete", data: "[1]" }]);
    expect(next.rest).toBe("");
  });

  it("handles CRLF and heartbeat events", () => {
    const { events } = parseSseChunk("event: heartbeat\r\ndata: null\r\n\r\nevent: error\r\ndata: null\r\n\r\n");
    expect(events.map((e) => e.event)).toEqual(["heartbeat", "error"]);
  });
});

describe("firstOutput / errorMessage", () => {
  it("unwraps Gradio output arrays", () => {
    expect(firstOutput('[{"embeddings": [[0.1]]}]')).toEqual({ embeddings: [[0.1]] });
    expect(firstOutput("not json")).toBeUndefined();
    expect(firstOutput("{}")).toBeUndefined();
  });

  it("reads gr.Error messages", () => {
    expect(errorMessage('{"error": "Invalid signature", "visible": true}')).toBe("Invalid signature");
    expect(errorMessage("null")).toBe("ML service error");
  });
});
