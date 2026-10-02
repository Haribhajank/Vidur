import { describe, expect, it } from "vitest";
import { learningOrder } from "@/lib/learningOrder";

describe("learningOrder", () => {
  it("puts prerequisites first and keeps original order otherwise", () => {
    // c depends on a; b depends on c
    const order = learningOrder(["b", "c", "a", "d"], [
      { parent: "a", child: "c" },
      { parent: "c", child: "b" },
    ]);
    expect(order).toEqual(["a", "c", "b", "d"]);
  });

  it("is stable with no edges and ignores unknown ids", () => {
    expect(learningOrder(["x", "y", "z"], [{ parent: "q", child: "y" }])).toEqual(["x", "y", "z"]);
  });

  it("never drops concepts when a cycle exists", () => {
    const order = learningOrder(["a", "b", "c"], [
      { parent: "a", child: "b" },
      { parent: "b", child: "a" },
    ]);
    expect(order).toEqual(["c", "a", "b"]);
  });
});
